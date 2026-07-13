// @test-kind: e2e
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertNoLeakedGodotProcesses, startServer, type E2EServer } from './helpers/harness.js';

let server: E2EServer | null = null;

afterEach(async () => {
  if (server) {
    const active = server;
    server = null;
    await active.close();
  }
});

function payload(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

describe('compound verification workflow through MCP', () => {
  it('runs, asserts independent runtime evidence, and tears down deterministically', async () => {
    server = await startServer();
    const result = await server.call('verify_project', {
      projectPath: server.projectPath,
      scene: 'main.tscn',
      waitFrames: 3,
      assertions: [
        { kind: 'node_exists', nodePath: '/root/Main/Anchor' },
        { kind: 'group_count', group: 'definitely-empty-verification-group', count: 0 },
        { kind: 'log_contains', text: 'e2e-fixture-ready' },
      ],
    });
    expect(result.isError, result.text).toBe(false);
    expect(payload(result.text)).toMatchObject({
      passed: true, started: true, stopped: true, teardown: true,
      assertions: [{ passed: true }, { passed: true, actual: 0 }, { passed: true }],
    });
    await assertNoLeakedGodotProcesses(server.root);
    expect(readFileSync(join(server.projectPath, 'project.godot'), 'utf8')).not.toContain('McpInteractionServer');
  });

  it('returns failed assertion evidence and still tears down', async () => {
    server = await startServer();
    const result = await server.call('verify_project', {
      projectPath: server.projectPath,
      assertions: [{ kind: 'node_exists', nodePath: '/root/Main/DefinitelyMissing' }],
    });
    expect(result.isError).toBe(true);
    expect(payload(result.text)).toMatchObject({
      passed: false, stopped: true,
      assertions: [{ kind: 'node_exists', passed: false }],
    });
    await assertNoLeakedGodotProcesses(server.root);
  });

  it('captures bounded screenshot evidence when a renderer is required', async () => {
    if (process.env.GODOT_MCP_RENDER_TEST !== '1') return;
    server = await startServer();
    const result = await server.call('verify_project', {
      projectPath: server.projectPath, captureScreenshot: true,
    });
    expect(result.isError, result.text).toBe(false);
    expect(payload(result.text)).toMatchObject({
      passed: true,
      screenshot: {
        captured: true, width: expect.any(Number), height: expect.any(Number),
        bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });
});
