// @test-kind: e2e
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type E2EServer } from './helpers/harness.js';

/**
 * Phase 1 independent observers that the representative suite does not yet
 * exercise: signal delivery observed through group membership, log cursors,
 * screenshot behavior in the headless display mode, and export failure
 * classification without installed templates.
 */

let server: E2EServer | null = null;

afterEach(async () => {
  if (server) {
    const active = server;
    server = null;
    await active.close();
  }
});

async function startedGame(): Promise<E2EServer> {
  server = await startServer();
  const started = await server.call('run_project', { projectPath: server.projectPath });
  expect(started.isError, started.text).toBe(false);
  await server.waitForGameConnection();
  return server;
}

describe('signal observer', () => {
  it('observes a connected signal firing through an independent group query', async () => {
    const game = await startedGame();

    const connected = await game.call('game_connect_signal', {
      nodePath: '/root/Main',
      signalName: 'child_entered_tree',
      targetPath: '/root/Main',
      method: 'observe_child',
    });
    expect(connected.isError, connected.text).toBe(false);

    // Trigger the signal with an ordinary unprivileged mutation.
    const spawned = await game.call('game_spawn_node', {
      type: 'Node2D',
      name: 'SignalProbe',
      parentPath: '/root/Main',
    });
    expect(spawned.isError, spawned.text).toBe(false);

    // Independent observation: the handler tagged the new node into a group.
    const observed = await game.call('game_get_nodes_in_group', { group: 'observed-by-signal' });
    expect(observed.isError, observed.text).toBe(false);
    expect(observed.text).toContain('SignalProbe');

    // Disconnect and verify delivery stops: the next spawn is not tagged.
    const disconnected = await game.call('game_disconnect_signal', {
      nodePath: '/root/Main',
      signalName: 'child_entered_tree',
      targetPath: '/root/Main',
      method: 'observe_child',
    });
    expect(disconnected.isError, disconnected.text).toBe(false);
    await game.call('game_spawn_node', { type: 'Node2D', name: 'UnobservedProbe', parentPath: '/root/Main' });
    const after = await game.call('game_get_nodes_in_group', { group: 'observed-by-signal' });
    expect(after.text).not.toContain('UnobservedProbe');

    await game.call('stop_project');
  });

  it('covers bound, deferred, one-shot, listed, emitted, and disconnected signals', async () => {
    const game = await startedGame();
    const connection = {
      nodePath: '/root/Main',
      signalName: 'e2e_event',
      targetPath: '/root/Main',
      method: 'observe_value',
      binds: ['-bound'],
    };

    const connected = await game.call('game_connect_signal', {
      ...connection,
      deferred: true,
      oneShot: true,
    });
    expect(connected.isError, connected.text).toBe(false);

    const listed = await game.call('game_list_signals', { nodePath: '/root/Main' });
    expect(listed.isError, listed.text).toBe(false);
    expect(listed.text).toContain('e2e_event');
    expect(listed.text).toContain('observe_value');

    const emitted = await game.call('game_emit_signal', {
      nodePath: '/root/Main', signalName: 'e2e_event', args: [7],
    });
    expect(emitted.isError, emitted.text).toBe(false);
    await game.call('game_wait');
    const delivered = await game.call('game_get_nodes_in_group', { group: 'signal-value-7-bound' });
    expect(delivered.text).toContain('/root/Main');

    await game.call('game_emit_signal', { nodePath: '/root/Main', signalName: 'e2e_event', args: [8] });
    await game.call('game_wait');
    const oneShot = await game.call('game_get_nodes_in_group', { group: 'signal-value-8-bound' });
    expect(oneShot.text).not.toContain('/root/Main');

    const persistent = { ...connection, binds: ['-persistent'], referenceCounted: true };
    const persistentDisconnect = { ...connection, binds: ['-persistent'] };
    expect((await game.call('game_connect_signal', persistent)).isError).toBe(false);
    expect((await game.call('game_connect_signal', persistent)).isError).toBe(false);
    expect((await game.call('game_disconnect_signal', persistentDisconnect)).isError).toBe(false);

    await game.call('game_emit_signal', { nodePath: '/root/Main', signalName: 'e2e_event', args: [9] });
    const stillConnected = await game.call('game_get_nodes_in_group', { group: 'signal-value-9-persistent' });
    expect(stillConnected.text).toContain('/root/Main');

    expect((await game.call('game_disconnect_signal', persistentDisconnect)).isError).toBe(false);
    await game.call('game_emit_signal', { nodePath: '/root/Main', signalName: 'e2e_event', args: [10] });
    const disconnected = await game.call('game_get_nodes_in_group', { group: 'signal-value-10-persistent' });
    expect(disconnected.text).not.toContain('/root/Main');

    const missing = await game.call('game_connect_signal', { ...connection, signalName: 'missing_signal' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/signal.*not found/i);
    await game.call('stop_project');
  });
});

describe('log observer', () => {
  it('captures game stdout and the debug output across the process boundary', async () => {
    const game = await startedGame();

    const debug = await game.call('get_debug_output');
    expect(debug.isError, debug.text).toBe(false);
    expect(debug.text).toContain('e2e-fixture-ready');

    // game_get_logs is a cursor: after one read, old lines are not repeated.
    const first = await game.call('game_get_logs');
    expect(first.isError, first.text).toBe(false);
    const second = await game.call('game_get_logs');
    expect(second.isError, second.text).toBe(false);
    expect(second.text).not.toContain('e2e-fixture-ready');

    await game.call('stop_project');
  });
});

describe('screenshot observer', () => {
  it('either returns a decodable PNG or a structured headless limitation', async () => {
    const game = await startedGame();
    const result = await game.call('game_screenshot');
    if (result.isError) {
      // The headless dummy renderer cannot capture the viewport; the failure
      // must be a structured tool error, not a crash or an empty payload.
      expect(result.text).toMatch(/screenshot|viewport|image|failed/i);
    } else {
      const raw = result.raw as { content: { type: string; data?: string; mimeType?: string }[] };
      const image = raw.content.find(item => item.type === 'image');
      expect(image?.mimeType).toBe('image/png');
      const png = Buffer.from(image?.data ?? '', 'base64');
      // PNG signature plus IHDR dimensions.
      expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect(png.readUInt32BE(16)).toBeGreaterThan(0);
      expect(png.readUInt32BE(20)).toBeGreaterThan(0);
    }
    await game.call('stop_project');
  });
});

describe('export observer', () => {
  it('classifies a missing export preset as a structured failure', async () => {
    server = await startServer();
    const result = await server.call('export_project', {
      projectPath: server.projectPath,
      presetName: 'Nonexistent Preset',
      outputPath: 'build/out.x86_64',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/preset|export/i);
  });
});
