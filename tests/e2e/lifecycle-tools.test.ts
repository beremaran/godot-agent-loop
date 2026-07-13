// @test-kind: e2e
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createTempProject, repoRoot, startServer, type E2EServer } from './helpers/harness.js';

const execFileAsync = promisify(execFile);

/**
 * Phase 2: the lifecycle and discovery tools (launch_editor, run_project,
 * get_debug_output, stop_project, get_godot_version, list_projects,
 * get_project_info) through the complete MCP path: process ownership,
 * repeated launches, self-exiting projects, output ordering, and the
 * missing-binary startup failure.
 */

let server: E2EServer | null = null;

afterEach(async () => {
  if (server) {
    const active = server;
    server = null;
    await active.close();
  }
});

describe('discovery tools', () => {
  it('reports the real engine version', async () => {
    server = await startServer();
    const version = await server.call('get_godot_version');
    expect(version.isError, version.text).toBe(false);
    expect(version.text).toMatch(/^4\.\d+/);
  });

  it('lists projects in a directory, recursively when asked', async () => {
    server = await startServer();
    const flat = await server.call('list_projects', { directory: server.root });
    expect(flat.isError, flat.text).toBe(false);
    expect(flat.text).toContain(server.projectPath);

    // A nested project inside the allowed root: found only with recursion.
    const nestedDir = join(server.root, 'nested/deeper/game');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, 'project.godot'), 'config_version=5\n');
    const shallow = await server.call('list_projects', { directory: join(server.root, 'nested') });
    expect(shallow.text).not.toContain('deeper/game');
    const recursive = await server.call('list_projects', { directory: join(server.root, 'nested'), recursive: true });
    expect(recursive.isError, recursive.text).toBe(false);
    expect(recursive.text).toContain(nestedDir);
  });

  it('reads project metadata through the engine-facing structure scan', async () => {
    server = await startServer();
    const info = await server.call('get_project_info', { projectPath: server.projectPath });
    expect(info.isError, info.text).toBe(false);
    expect(info.text).toContain('godot-mcp-e2e-fixture');
    expect(info.text).toMatch(/"scenes":\s*\d|main\.tscn/);
  });

  it('fails get_project_info for a directory that is not a project', async () => {
    server = await startServer();
    const result = await server.call('get_project_info', { projectPath: server.root });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Not a valid Godot project/i);
  });
});

describe('project process ownership', () => {
  it('preserves output ordering and survives repeated launches', async () => {
    server = await startServer();
    writeFileSync(join(server.projectPath, 'main.gd'), [
      'extends Node2D',
      '',
      '',
      'func _ready() -> void:',
      '\tprint("order-alpha")',
      '\tprint("order-beta")',
      '\tprint("order-gamma")',
      '',
    ].join('\n'));

    const first = await server.call('run_project', { projectPath: server.projectPath });
    expect(first.isError, first.text).toBe(false);
    await server.waitForGameConnection();

    // Relaunching without stopping must replace the process, not stack a second one.
    const second = await server.call('run_project', { projectPath: server.projectPath });
    expect(second.isError, second.text).toBe(false);
    await server.waitForGameConnection();

    const debug = await server.call('get_debug_output');
    const alpha = debug.text.indexOf('order-alpha');
    const beta = debug.text.indexOf('order-beta');
    const gamma = debug.text.indexOf('order-gamma');
    expect(alpha, debug.text).toBeGreaterThanOrEqual(0);
    expect(beta).toBeGreaterThan(alpha);
    expect(gamma).toBeGreaterThan(beta);

    const stopped = await server.call('stop_project');
    expect(stopped.isError, stopped.text).toBe(false);
    // Stopping twice is a structured error, not a crash.
    const again = await server.call('stop_project');
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/No active Godot process/i);
  });

  it('observes a project that exits on its own', async () => {
    server = await startServer();
    writeFileSync(join(server.projectPath, 'main.gd'), [
      'extends Node2D',
      '',
      '',
      'func _ready() -> void:',
      '\tprint("exiting-now")',
      '\tget_tree().quit(3)',
      '',
    ].join('\n'));

    const started = await server.call('run_project', { projectPath: server.projectPath });
    expect(started.isError, started.text).toBe(false);

    // The process exits by itself; afterwards the server must know it is gone.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const result = await server.call('get_debug_output');
      if (result.isError && /No active Godot process/i.test(result.text)) break;
      expect(Date.now(), 'project never exited').toBeLessThan(deadline);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const stopped = await server.call('stop_project');
    expect(stopped.isError).toBe(true);
  });

  it('launches a headless editor process and reports success', async () => {
    server = await startServer();
    const launched = await server.call('launch_editor', { projectPath: server.projectPath });
    expect(launched.isError, launched.text).toBe(false);

    // Independent observation: an editor process for this project exists.
    const deadline = Date.now() + 15_000;
    let seen = false;
    while (!seen && Date.now() < deadline) {
      try {
        const { stdout } = await execFileAsync('pgrep', ['-af', server.projectPath]);
        seen = stdout.split('\n').some(line => line.includes('-e'));
      } catch {
        // No match yet.
      }
      if (!seen) await new Promise(resolve => setTimeout(resolve, 250));
    }
    expect(seen, 'no editor process appeared').toBe(true);

    // The editor is intentionally user-owned (no stop_editor tool), so the
    // test releases it before teardown's leak assertion.
    await execFileAsync('pkill', ['-f', server.projectPath]).catch(() => undefined);
  });

  it('fails run_project cleanly for an invalid project directory', async () => {
    server = await startServer();
    const result = await server.call('run_project', { projectPath: server.root });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Not a valid Godot project/i);
  });
});

describe('missing binary behavior', () => {
  it('starts in compatibility mode but fails every engine-backed tool with a structured error', async () => {
    // Without strictPathValidation the server documents that it falls back to
    // a default path and keeps running; the failure must then surface as a
    // structured tool error, never a hang or crash.
    const project = createTempProject();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(repoRoot, 'build/index.js')],
      env: {
        ...getDefaultEnvironment(),
        GODOT_PATH: join(project.root, 'not-a-binary'),
        PATH: '/nonexistent',
        GODOT_MCP_ALLOWED_DIRS: project.root,
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'godot-mcp-e2e', version: '0.0.0' });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'get_godot_version', arguments: {} });
      expect(result.isError).toBe(true);
      const text = (result.content as { type: string; text?: string }[])
        .map(item => item.text ?? '').join('\n');
      expect(text).toMatch(/Failed to get Godot version|Could not find/i);
    } finally {
      await client.close().catch(() => undefined);
      const { rmSync } = await import('node:fs');
      rmSync(project.root, { recursive: true, force: true });
    }
  });
});
