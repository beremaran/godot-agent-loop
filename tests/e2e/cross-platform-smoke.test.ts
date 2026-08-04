// @test-kind: e2e
import { afterEach, describe, expect, it } from 'vitest';
import { createTempProject, startServer, type E2EServer } from './helpers/harness.js';

let server: E2EServer | null = null;

afterEach(async () => {
  if (server) {
    const active = server;
    server = null;
    await active.close();
  }
});

function payload(text: string): unknown {
  return JSON.parse(text) as unknown;
}

describe('portable process, path, input, and platform acceptance', () => {
  it('runs a Unicode-path project and tears it down through the full MCP boundary', async () => {
    const project = createTempProject({ name: 'Cross Platform Ω Project' });
    server = await startServer({ project });

    const version = await server.call('get_godot_version');
    expect(version.isError, version.text).toBe(false);
    expect(version.text).toMatch(/^4\.(4|7)/);

    const info = await server.call('get_project_info', { projectPath: server.projectPath });
    expect(info.isError, info.text).toBe(false);
    expect(info.text).toContain('godot-agent-loop-e2e-fixture');

    const started = await server.call('run_project', { projectPath: server.projectPath });
    expect(started.isError, started.text).toBe(false);
    await server.waitForGameConnection();

    const action = await server.call('game_input_action', {
      action: 'add_action', actionName: 'portable_acceptance',
    });
    expect(action.isError, action.text).toBe(false);
    const pressed = await server.call('game_input_action', {
      action: 'set_strength', actionName: 'portable_acceptance', strength: 0.75,
    });
    expect(pressed.isError, pressed.text).toBe(false);
    const state = await server.call('game_input_state', {
      action: 'query', actions: ['portable_acceptance'],
    });
    expect(state.isError, state.text).toBe(false);
    const actionState = (payload(state.text) as {
      actions: Record<string, { pressed: boolean; strength: number }>;
    }).actions.portable_acceptance;
    expect(actionState.pressed).toBe(true);
    expect(actionState.strength).toBeCloseTo(0.75, 4);

    const osInfo = await server.call('game_os_info');
    expect(osInfo.isError, osInfo.text).toBe(false);
    const osInfoData = payload(osInfo.text) as {
      os_name: string; screen_size: { x: number; y: number };
    };
    expect(osInfoData.os_name).not.toBe('');
    expect(osInfoData.screen_size.x).toBeGreaterThan(0);

    const stopped = await server.call('stop_project');
    expect(stopped.isError, stopped.text).toBe(false);
  });
});
