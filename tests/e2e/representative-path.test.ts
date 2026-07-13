// @test-kind: e2e
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolDefinitions } from '../../src/tool-definitions.js';
import {
  assertNoLeakedGodotProcesses,
  createTempProject,
  startServer,
  type E2EServer,
} from './helpers/harness.js';

/**
 * Phase 1 representative full-path coverage: every architectural seam of
 *
 *   MCP client -> build/index.js over stdio -> tool discovery/validation ->
 *   real handler and service -> subprocess or TCP transport -> real Godot ->
 *   observable engine/filesystem result -> MCP response
 *
 * is crossed at least once, with independent observations (filesystem reads,
 * follow-up requests, process checks) rather than response echoes.
 */

let server: E2EServer | null = null;

afterEach(async () => {
  if (server) {
    const active = server;
    server = null;
    await active.close();
  }
});

describe('MCP tool discovery', () => {
  it('lists all advertised tools through a real MCP client', async () => {
    server = await startServer();
    const listed = await server.client.listTools();
    expect(listed.tools.map(tool => tool.name).sort())
      .toEqual(toolDefinitions.map(tool => tool.name).sort());
  });

  it('rejects an unknown tool with a protocol error', async () => {
    server = await startServer();
    await expect(server.client.callTool({ name: 'not_a_real_tool', arguments: {} }))
      .rejects.toThrow(/Unknown tool/);
  });

  it('rejects invalid arguments before any handler runs', async () => {
    server = await startServer();
    await expect(server.client.callTool({ name: 'create_scene', arguments: { projectPath: 42 } }))
      .rejects.toThrow(/projectPath|Invalid/i);
  });
});

describe('headless operation path', () => {
  it('creates a scene on disk and reads it back through the engine', async () => {
    server = await startServer();
    const created = await server.call('create_scene', {
      projectPath: server.projectPath,
      scenePath: 'scenes/level.tscn',
      rootNodeType: 'Node2D',
    });
    expect(created.isError, created.text).toBe(false);

    // Independent observation 1: the file exists and is a Godot scene.
    const sceneFile = join(server.projectPath, 'scenes/level.tscn');
    expect(existsSync(sceneFile)).toBe(true);
    // Godot 4.7 appends a unique_id attribute to node headers; 4.4 does not.
    expect(readFileSync(sceneFile, 'utf8')).toMatch(/\[node name="root" type="Node2D"[^\]]*\]/);

    const added = await server.call('add_node', {
      projectPath: server.projectPath,
      scenePath: 'scenes/level.tscn',
      nodeType: 'Sprite2D',
      nodeName: 'Player',
    });
    expect(added.isError, added.text).toBe(false);

    // Independent observation 2: a separate engine invocation reloads the
    // scene and reports the node added by the previous invocation.
    const read = await server.call('read_scene', {
      projectPath: server.projectPath,
      scenePath: 'scenes/level.tscn',
    });
    expect(read.isError, read.text).toBe(false);
    expect(read.text).toContain('"Player"');
    expect(read.text).toContain('Sprite2D');
  });

  it('returns a structured failure for a missing scene', async () => {
    server = await startServer();
    const result = await server.call('read_scene', {
      projectPath: server.projectPath,
      scenePath: 'scenes/absent.tscn',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/does not exist/i);
  });
});

describe('lifecycle and runtime path', () => {
  it('runs the project, queries and mutates the live scene tree, waits frames, and stops cleanly', async () => {
    server = await startServer();
    const started = await server.call('run_project', { projectPath: server.projectPath });
    expect(started.isError, started.text).toBe(false);
    expect(started.text).toContain(String(server.runtimePort));
    await server.waitForGameConnection();

    // Runtime query: the live tree contains the fixture scene's nodes.
    const tree = await server.call('game_get_scene_tree');
    expect(tree.isError, tree.text).toBe(false);
    expect(tree.text).toContain('Main');
    expect(tree.text).toContain('Anchor');

    // Runtime mutation, verified by an independent follow-up query.
    const spawned = await server.call('game_spawn_node', {
      type: 'Node2D',
      name: 'SpawnedByE2E',
      parentPath: '/root/Main',
    });
    expect(spawned.isError, spawned.text).toBe(false);
    const treeAfter = await server.call('game_get_scene_tree');
    expect(treeAfter.text).toContain('SpawnedByE2E');

    // Async command: waiting frames must round-trip through the engine loop.
    const waited = await server.call('game_wait', { frames: 3 });
    expect(waited.isError, waited.text).toBe(false);
    expect(waited.text).toContain('waited_frames');

    // Debug output crossed the process boundary.
    const debug = await server.call('get_debug_output');
    expect(debug.isError, debug.text).toBe(false);
    expect(debug.text).toContain('McpInteractionServer: Listening on 127.0.0.1:' + String(server.runtimePort));

    // Stop, then observe process ownership independently of the response.
    const stopped = await server.call('stop_project');
    expect(stopped.isError, stopped.text).toBe(false);
    await assertNoLeakedGodotProcesses(server.root);

    // The interaction autoload must have been removed from the project again.
    expect(readFileSync(join(server.projectPath, 'project.godot'), 'utf8'))
      .not.toContain('McpInteractionServer');
  });

  it('denies privileged commands by default and allows them with explicit opt-in', async () => {
    server = await startServer();
    await server.call('run_project', { projectPath: server.projectPath });
    await server.waitForGameConnection();
    const denied = await server.call('game_eval', { code: 'return 42' });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/privileged|disabled/i);
    await server.call('stop_project');
    await server.close();
    server = null;

    const privileged = await startServer({ allowPrivileged: true });
    server = privileged;
    await privileged.call('run_project', { projectPath: privileged.projectPath });
    await privileged.waitForGameConnection();
    const allowed = await privileged.call('game_eval', { code: 'return 40 + 2' });
    expect(allowed.isError, allowed.text).toBe(false);
    expect(allowed.text).toContain('42');
    await privileged.call('stop_project');
  });

  it('rejects a project outside the allowed roots without touching Godot', async () => {
    server = await startServer();
    const outside = createTempProject();
    try {
      const result = await server.call('run_project', { projectPath: outside.projectPath });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/allowed roots/i);
    } finally {
      const { rmSync } = await import('node:fs');
      rmSync(outside.root, { recursive: true, force: true });
    }
  });
});

describe('shutdown behavior across seams', () => {
  it('survives Godot stopping while a runtime request is in flight', async () => {
    server = await startServer();
    await server.call('run_project', { projectPath: server.projectPath });
    await server.waitForGameConnection();

    // A long wait is pending when the project is stopped underneath it.
    const pendingWait = server.call('game_wait', { frames: 100000 });
    await new Promise(resolve => setTimeout(resolve, 500));
    const stopped = await server.call('stop_project');
    expect(stopped.isError, stopped.text).toBe(false);

    const waitResult = await pendingWait;
    expect(waitResult.isError).toBe(true);
    expect(waitResult.text).toMatch(/Disconnected|closed|timed out|cancelled/i);
    await assertNoLeakedGodotProcesses(server.root);
  });

  it('terminating the MCP server tears down the Godot process it owns', async () => {
    server = await startServer();
    await server.call('run_project', { projectPath: server.projectPath });
    await server.waitForGameConnection();
    const root = server.root;

    // Close the client transport: the server process is killed while its
    // Godot child is running. No Godot process may survive it.
    const active = server;
    server = null;
    await active.client.close();
    await assertNoLeakedGodotProcesses(root);
    const { rmSync } = await import('node:fs');
    rmSync(root, { recursive: true, force: true });
  });
});
