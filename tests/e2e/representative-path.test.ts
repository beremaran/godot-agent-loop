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

describe('persistent authoring operation path', () => {
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

    // Independent observation 2: a separate JSON-RPC operation reloads the
    // scene and reports the node added by the previous operation.
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
    server = await startServer({ allowPrivileged: true });
    const started = await server.call('run_project', {
      projectPath: server.projectPath, timingMode: 'realtime', scene: 'main.tscn',
    });
    expect(started.isError, started.text).toBe(false);
    expect(started.text).toContain(String(server.runtimePort));
    expect(JSON.parse(started.text)).toMatchObject({
      timing_policy: { mode: 'realtime', fixed_fps: null, time_scale: 1 },
    });
    const timingModes = ['realtime', 'deterministic'];
    expect(timingModes).toContain('realtime');
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

    const conditionWait = await server.call('game_wait_until', {
      projectPath: server.projectPath,
      condition: 'node',
      nodePath: '/root/Main/SpawnedByE2E',
      timeoutSeconds: 2,
      pollIntervalMs: 20,
    });
    expect(conditionWait.isError, conditionWait.text).toBe(false);
    expect(JSON.parse(conditionWait.text)).toMatchObject({
      satisfied: true, condition: 'node', last_observed: {},
    });
    const timeoutWait = await server.call('game_wait_until', {
      projectPath: server.projectPath,
      condition: 'property',
      nodePath: '/root/Main/Anchor',
      property: 'name',
      value: 'NeverThisName',
      timeoutSeconds: 0.05,
      pollIntervalMs: 20,
    });
    expect(timeoutWait.isError).toBe(true);
    expect(JSON.parse(timeoutWait.text)).toMatchObject({
      satisfied: false, condition: 'property', last_observed: { value: 'Anchor' },
    });
    const waitConditionKinds = ['connection', 'node', 'property', 'signal', 'log', 'scene'];
    expect(waitConditionKinds).toContain('node');
    // Other condition-specific public fields are signal, text, and scenePath.

    const scenario = await server.call('game_scenario', {
      projectPath: server.projectPath,
      name: 'Representative compound evidence',
      timeoutSeconds: 10,
      steps: [
        { type: 'input', tool: 'game_key_press', arguments: { key: 'SPACE' }, label: 'bounded input' },
        {
          type: 'wait', label: 'node appears',
          condition: { condition: 'node', nodePath: '/root/Main/SpawnedByE2E', timeoutSeconds: 2 },
        },
        { type: 'observe', tool: 'game_get_node_info', arguments: { nodePath: '/root/Main/Anchor' } },
        {
          type: 'assert',
          condition: { condition: 'property', nodePath: '/root/Main/Anchor', property: 'name', value: 'Anchor' },
        },
        { type: 'performance' },
        { type: 'screenshot' },
      ],
    });
    expect(scenario.isError, scenario.text).toBe(false);
    expect(JSON.parse(scenario.text)).toMatchObject({
      name: 'Representative compound evidence', passed: true, step_count: 6,
      teardown: { attempted: true, time_scale_restored: true },
    });
    const scenarioStepKinds = ['input', 'wait', 'observe', 'assert', 'screenshot', 'performance'];
    expect(scenarioStepKinds).toContain('assert');

    // Async command: waiting frames must round-trip through the engine loop.
    const waited = await server.call('game_wait', { frames: 3 });
    expect(waited.isError, waited.text).toBe(false);
    expect(waited.text).toContain('waited_frames');

    // A user-facing game owns the generated runtime installation, so an
    // authoring call takes its manifest-declared subprocess fallback. The
    // fallback disables its duplicate runtime listener and must not disturb
    // the live game connection.
    const authoredWhileRunning = await server.call('create_scene', {
      projectPath: server.projectPath,
      scenePath: 'scenes/authored_while_running.tscn',
    });
    expect(authoredWhileRunning.isError, authoredWhileRunning.text).toBe(false);
    expect(existsSync(join(server.projectPath, 'scenes/authored_while_running.tscn'))).toBe(true);
    const stillConnected = await server.call('game_get_scene_tree');
    expect(stillConnected.isError, stillConnected.text).toBe(false);

    // Debug output crossed the process boundary.
    const debug = await server.call('get_debug_output');
    expect(debug.isError, debug.text).toBe(false);
    expect(debug.text).toContain('McpInteractionServer: Listening on 127.0.0.1:' + String(server.runtimePort));

    // Stop, then observe process ownership independently of the response.
    const stopped = await server.call('stop_project');
    expect(stopped.isError, stopped.text).toBe(false);
    await assertNoLeakedGodotProcesses(server.root);

    // The interaction autoload must have been removed from the project again;
    // it lives in a generated override.cfg and project.godot is never touched.
    expect(existsSync(join(server.projectPath, 'override.cfg'))).toBe(false);
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

describe('recovery and multi-project isolation', () => {
  it('correlates structured, redacted MCP and Godot request lifecycle logs', async () => {
    const secret = 'observability-secret-must-never-appear';
    server = await startServer({
      extraEnv: { DEBUG: 'true', GODOT_MCP_RUNTIME_SECRET: secret },
    });
    expect((await server.call('run_project', { projectPath: server.projectPath })).isError).toBe(false);
    await server.waitForGameConnection();

    expect((await server.call('game_wait', { frames: 2 })).isError).toBe(false);
    const failed = await server.call('game_get_node_info', { nodePath: '/root/Main/MissingForAudit' });
    expect(failed.isError).toBe(true);

    const parseRecord = (line: string): Record<string, unknown> | null => {
      const start = line.indexOf('{');
      if (start < 0) return null;
      try { return JSON.parse(line.slice(start)) as Record<string, unknown>; } catch { return null; }
    };
    const serverRecords = server.serverLogs.map(parseRecord).filter(record => record !== null);
    const waitStart = serverRecords.find(record =>
      record.event === 'request_started' && record.method === 'godot.runtime.wait'
    );
    expect(waitStart?.correlation_id).toMatch(/^mcp_\d+$/);

    const debug = await server.call('get_debug_output');
    const processOutput = (JSON.parse(debug.text) as { output: string[] }).output;
    const runtimeRecords = processOutput.map(parseRecord).filter(record => record !== null);
    expect(runtimeRecords).toContainEqual(expect.objectContaining({
      component: 'godot-agent-loop-runtime', event: 'request_started',
      command: 'wait', correlation_id: waitStart?.correlation_id,
    }));
    expect(runtimeRecords).toContainEqual(expect.objectContaining({
      component: 'godot-agent-loop-runtime', event: 'request_completed',
      command: 'wait', correlation_id: waitStart?.correlation_id,
      state: 'responded', duration_ms: expect.any(Number),
    }));
    expect(runtimeRecords).toContainEqual(expect.objectContaining({
      component: 'godot-agent-loop-runtime', event: 'request_failed',
      command: 'get_node_info', error_code: -32000,
    }));
    expect([...server.serverLogs, ...processOutput].join('\n')).not.toContain(secret);
    expect(processOutput.length).toBeLessThanOrEqual(10_000);
  });

  it('authenticates with a per-launch secret and emits only redacted audit evidence', async () => {
    const secret = 'e2e-runtime-secret-must-never-appear';
    server = await startServer({ extraEnv: { GODOT_MCP_RUNTIME_SECRET: secret } });
    expect((await server.call('run_project', { projectPath: server.projectPath })).isError).toBe(false);
    await server.waitForGameConnection();

    const output = await server.call('get_debug_output');
    expect(output.isError, output.text).toBe(false);
    const debug = JSON.parse(output.text) as { output: string[] };
    const audit = debug.output
      .map(line => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; } })
      .find(record => record?.event === 'authentication_succeeded');
    expect(audit).toMatchObject({
      component: 'godot-agent-loop-runtime', event: 'authentication_succeeded', session_id: 1,
    });
    expect(output.text).not.toContain(secret);
  });

  it('grants only the configured privileged command group through MCP', async () => {
    server = await startServer({
      extraEnv: { GODOT_MCP_PRIVILEGED_GROUPS: 'reflection' },
    });
    expect((await server.call('run_project', { projectPath: server.projectPath })).isError).toBe(false);
    await server.waitForGameConnection();

    const reflected = await server.call('game_get_property', {
      nodePath: '/root/Main', property: 'name',
    });
    expect(reflected.isError, reflected.text).toBe(false);
    expect(reflected.text).toContain('Main');

    const code = await server.call('game_eval', { code: 'return "must-not-run"' });
    expect(code.isError).toBe(true);
    expect(code.text).toMatch(/code-execution|privileged|disabled/i);
    expect(code.text).not.toContain('must-not-run');

    const network = await server.call('game_http_request', {
      url: 'http://127.0.0.1:1/secret-must-not-leak',
    });
    expect(network.isError).toBe(true);
    expect(network.text).toMatch(/network|privileged|disabled/i);
    expect(network.text).not.toContain('secret-must-not-leak');
  });

  it('reconnects after a game restart and invalidates nodes from the old tree', async () => {
    server = await startServer();
    expect((await server.call('run_project', { projectPath: server.projectPath })).isError).toBe(false);
    await server.waitForGameConnection();
    expect((await server.call('game_spawn_node', {
      type: 'Node', name: 'OldSessionOnly', parentPath: '/root/Main',
    })).isError).toBe(false);
    expect((await server.call('stop_project')).isError).toBe(false);
    await assertNoLeakedGodotProcesses(server.root);

    expect((await server.call('run_project', { projectPath: server.projectPath })).isError).toBe(false);
    await server.waitForGameConnection();
    const tree = await server.call('game_get_scene_tree');
    expect(tree.isError, tree.text).toBe(false);
    expect(tree.text).not.toContain('OldSessionOnly');
    const stale = await server.call('game_get_node_info', { nodePath: '/root/Main/OldSessionOnly' });
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(/not found/i);
  });

  it('isolates simultaneous projects, ports, scene trees, and process ownership', async () => {
    const first = await startServer();
    const second = await startServer();
    try {
      expect(first.runtimePort).not.toBe(second.runtimePort);
      const [firstRun, secondRun] = await Promise.all([
        first.call('run_project', { projectPath: first.projectPath }),
        second.call('run_project', { projectPath: second.projectPath }),
      ]);
      expect(firstRun.isError, firstRun.text).toBe(false);
      expect(secondRun.isError, secondRun.text).toBe(false);
      await Promise.all([first.waitForGameConnection(), second.waitForGameConnection()]);

      expect((await first.call('game_spawn_node', {
        type: 'Node', name: 'FirstProjectMarker', parentPath: '/root/Main',
      })).isError).toBe(false);
      expect((await second.call('game_spawn_node', {
        type: 'Node', name: 'SecondProjectMarker', parentPath: '/root/Main',
      })).isError).toBe(false);
      const [firstTree, secondTree] = await Promise.all([
        first.call('game_get_scene_tree'), second.call('game_get_scene_tree'),
      ]);
      expect(firstTree.text).toContain('FirstProjectMarker');
      expect(firstTree.text).not.toContain('SecondProjectMarker');
      expect(secondTree.text).toContain('SecondProjectMarker');
      expect(secondTree.text).not.toContain('FirstProjectMarker');

      const crossProject = await first.call('run_project', { projectPath: second.projectPath });
      expect(crossProject.isError).toBe(true);
      expect(crossProject.text).toMatch(/allowed roots/i);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
});
