// @test-kind: e2e
import { afterEach, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, type E2EServer } from './helpers/harness.js';

/**
 * Full-path E2E coverage for the runtime engine-state tools: pause, time scale,
 * process mode, world settings, window, locale, performance, logs, errors,
 * screenshots, and UI enumeration. Effects are observed through the engine
 * itself (frame counters, physics response, Engine/TranslationServer state)
 * rather than through the responses of the commands that caused them.
 */

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

async function startedGame(options: { privileged?: boolean } = {}): Promise<E2EServer> {
  server = await startServer({ allowPrivileged: options.privileged });
  const started = await server.call('run_project', { projectPath: server.projectPath });
  expect(started.isError, started.text).toBe(false);
  await server.waitForGameConnection();
  return server;
}

async function engineEval(game: E2EServer, code: string): Promise<unknown> {
  const result = await game.call('game_eval', { code });
  expect(result.isError, result.text).toBe(false);
  return (payload(result.text) as { result: unknown }).result;
}

describe('runtime engine-state tools through MCP', () => {
  it('game_pause halts the pausable tree and resuming restarts it', async () => {
    const game = await startedGame({ privileged: true });

    const paused = await game.call('game_pause', { paused: true });
    expect(paused.isError, paused.text).toBe(false);
    expect(payload(paused.text)).toMatchObject({ paused: true });

    // Independent observation: the engine reports a paused tree, and a pausable
    // node stops receiving process frames while the tree is paused.
    expect(await engineEval(game, 'return get_tree().paused')).toBe(true);

    // The default `paused` argument is true.
    await game.call('game_pause', { paused: false });
    const defaulted = await game.call('game_pause');
    expect(defaulted.isError, defaulted.text).toBe(false);
    expect(await engineEval(game, 'return get_tree().paused')).toBe(true);

    const resumed = await game.call('game_pause', { paused: false });
    expect(resumed.isError, resumed.text).toBe(false);
    expect(await engineEval(game, 'return get_tree().paused')).toBe(false);

    // The tree advances again once resumed.
    const before = await engineEval(game, 'return Engine.get_process_frames()') as number;
    await game.call('game_wait', { frames: 2 });
    const after = await engineEval(game, 'return Engine.get_process_frames()') as number;
    expect(after).toBeGreaterThan(before);
  });

  it('game_process_mode changes how a node behaves while the tree is paused', async () => {
    const game = await startedGame({ privileged: true });

    const set = await game.call('game_process_mode', { nodePath: '/root/Main/Anchor', mode: 'always' });
    expect(set.isError, set.text).toBe(false);
    expect(payload(set.text)).toMatchObject({ node_path: '/root/Main/Anchor', mode: 'always' });

    // Independent observation: the engine holds PROCESS_MODE_ALWAYS (3), and the
    // node still processes while the tree is paused.
    expect(await engineEval(game, 'return get_node("/root/Main/Anchor").process_mode'))
      .toBe(3);
    await game.call('game_pause', { paused: true });
    expect(await engineEval(game, 'return get_node("/root/Main/Anchor").can_process()')).toBe(true);

    // A pausable node cannot process under the same paused tree.
    await game.call('game_process_mode', { nodePath: '/root/Main/Tiles', mode: 'pausable' });
    expect(await engineEval(game, 'return get_node("/root/Main/Tiles").can_process()')).toBe(false);
    await game.call('game_pause', { paused: false });

    for (const [mode, value] of [['inherit', 0], ['pausable', 1], ['when_paused', 2], ['disabled', 4]] as const) {
      const applied = await game.call('game_process_mode', { nodePath: '/root/Main/Anchor', mode });
      expect(applied.isError, applied.text).toBe(false);
      expect(await engineEval(game, 'return get_node("/root/Main/Anchor").process_mode')).toBe(value);
    }

    // An unsupported mode is refused by the runtime's enum validation.
    const badMode = await game.call('game_process_mode', { nodePath: '/root/Main/Anchor', mode: 'whenever' });
    expect(badMode.isError).toBe(true);
    expect(badMode.text).toMatch(/mode must be one of/i);

    const missing = await game.call('game_process_mode', { nodePath: '/root/Ghost', mode: 'always' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/node not found/i);
  });

  it('game_time_scale get/set changes the engine clock', async () => {
    const game = await startedGame({ privileged: true });

    const initial = await game.call('game_time_scale', { action: 'get' });
    expect(initial.isError, initial.text).toBe(false);
    expect(payload(initial.text)).toMatchObject({ time_scale: 1 });

    const set = await game.call('game_time_scale', { action: 'set', timeScale: 2.5 });
    expect(set.isError, set.text).toBe(false);

    // Independent observation: the engine's own clock multiplier changed.
    expect(await engineEval(game, 'return Engine.time_scale')).toBe(2.5);

    const readBack = await game.call('game_time_scale', { action: 'get' });
    expect(payload(readBack.text)).toMatchObject({ time_scale: 2.5 });

    // A `set` with no value is a structured failure, not a silent default.
    const noValue = await game.call('game_time_scale', { action: 'set' });
    expect(noValue.isError).toBe(true);
    expect(noValue.text).toMatch(/time_scale is required|timeScale/i);

    // Zero is a legal freeze; negative is out of range.
    expect((await game.call('game_time_scale', { action: 'set', timeScale: 0 })).isError).toBe(false);
    expect(await engineEval(game, 'return Engine.time_scale')).toBe(0);
    const negative = await game.call('game_time_scale', { action: 'set', timeScale: -1 });
    expect(negative.isError).toBe(true);

    await game.call('game_time_scale', { action: 'set', timeScale: 1 });
  });

  it('game_world_settings applies gravity and gravity direction to the live physics space', async () => {
    const game = await startedGame({ privileged: true });

    const initial = await game.call('game_world_settings', { action: 'get' });
    expect(initial.isError, initial.text).toBe(false);
    expect(payload(initial.text)).toMatchObject({ physics_fps: 60 });

    const set = await game.call('game_world_settings', {
      action: 'set', gravity: 20, gravityDirection: { x: 1, y: 0, z: 0 }, physicsFps: 90,
    });
    expect(set.isError, set.text).toBe(false);
    expect(payload(set.text)).toMatchObject({
      gravity: 20, gravity_direction: { x: 1, y: 0, z: 0 }, physics_fps: 90,
    });

    // Independent observation: the engine tick rate changed, and a real
    // RigidBody3D accelerates along +X, proving the running physics space (not
    // just ProjectSettings) was updated.
    expect(await engineEval(game, 'return Engine.physics_ticks_per_second')).toBe(90);
    await game.call('game_set_property', { nodePath: '/root/Main/Physics3D/Crate', property: 'gravity_scale', value: 1 });
    await game.call('game_wait', { frames: 10, frameType: 'physics' });

    const velocity = await engineEval(game, [
      'var v = get_node("/root/Main/Physics3D/Crate").linear_velocity',
      'return [v.x, v.y, v.z]',
    ].join('\n')) as number[];
    expect(velocity[0]).toBeGreaterThan(0.5);
    expect(Math.abs(velocity[1])).toBeLessThan(0.5);

    const readBack = await game.call('game_world_settings', { action: 'get' });
    expect(payload(readBack.text)).toMatchObject({ gravity: 20, gravity_direction: { x: 1, y: 0, z: 0 } });

    const negative = await game.call('game_world_settings', { action: 'set', gravity: -5 });
    expect(negative.isError).toBe(true);
  });

  it('game_window reports the viewport and applies size changes', async () => {
    const game = await startedGame({ privileged: true });

    const initial = await game.call('game_window', { action: 'get' });
    expect(initial.isError, initial.text).toBe(false);
    const before = payload(initial.text) as { size: { x: number; y: number }; fullscreen: boolean; title: string };
    expect(before.size.x).toBeGreaterThan(0);
    expect(before.size.y).toBeGreaterThan(0);
    expect(typeof before.fullscreen).toBe('boolean');

    const unsupported = await game.call('game_window', {
      action: 'set', borderless: true, vsync: false,
    });
    expect(unsupported.isError).toBe(true);
    expect(unsupported.text).toMatch(/headless display driver/i);
    const set = await game.call('game_window', {
      action: 'set', width: 640, height: 360, title: 'e2e-window', position: { x: 17, y: 19 },
    });
    expect(set.isError, set.text).toBe(false);

    // Independent observation: the engine's root Window reports the new size and
    // title. This holds in headless mode because the root Window still exists.
    const observed = await engineEval(game, [
      'var win = get_tree().root',
      'return {"width": win.size.x, "height": win.size.y, "title": win.title, "position": win.position}',
    ].join('\n')) as { width: number; height: number; title: string; position: { x: number; y: number } };
    expect(observed).toMatchObject({ width: 640, height: 360, title: 'e2e-window', position: { x: 17, y: 19 } });

    const readBack = await game.call('game_window', { action: 'get' });
    expect(payload(readBack.text)).toMatchObject({ size: { x: 640, y: 360 }, title: 'e2e-window' });

    // width and height must be provided together.
    const halfPair = await game.call('game_window', { action: 'set', width: 800 });
    expect(halfPair.isError).toBe(true);
    expect(halfPair.text).toMatch(/together/i);
  });

  it('game_locale get/set/translate drives the TranslationServer', async () => {
    const game = await startedGame({ privileged: true });

    const initial = await game.call('game_locale', { action: 'get' });
    expect(initial.isError, initial.text).toBe(false);
    expect((payload(initial.text) as { locale: string }).locale).not.toBe('');

    const set = await game.call('game_locale', { action: 'set', locale: 'fr' });
    expect(set.isError, set.text).toBe(false);

    // Independent observation: the engine's TranslationServer changed locale.
    expect(await engineEval(game, 'return TranslationServer.get_locale()')).toBe('fr');
    expect((payload((await game.call('game_locale', { action: 'get' })).text) as { locale: string }).locale)
      .toBe('fr');

    // With no translation loaded, translate() returns the key unchanged.
    const translated = await game.call('game_locale', { action: 'translate', key: 'MISSING_KEY' });
    expect(translated.isError, translated.text).toBe(false);
    expect(payload(translated.text)).toMatchObject({ key: 'MISSING_KEY', translated: 'MISSING_KEY' });

    const noKey = await game.call('game_locale', { action: 'translate' });
    expect(noKey.isError).toBe(true);
    expect(noKey.text).toMatch(/key is required/i);
  });

  it('game_performance reports live engine counters', async () => {
    const game = await startedGame();

    const result = await game.call('game_performance');
    expect(result.isError, result.text).toBe(false);
    const metrics = payload(result.text) as Record<string, number>;
    for (const key of [
      'fps', 'frame_time', 'physics_frame_time', 'memory_static', 'object_count',
      'object_node_count', 'object_orphan_node_count',
    ]) {
      expect(metrics, `missing ${key}`).toHaveProperty(key);
      expect(typeof metrics[key], `${key} must be numeric`).toBe('number');
    }
    expect(metrics.object_count).toBeGreaterThan(0);
    expect(metrics.object_node_count).toBeGreaterThan(0);
    expect(metrics.memory_static).toBeGreaterThan(0);

    // Node count tracks a real spawn, so the counters are live rather than canned.
    await game.call('game_spawn_node', { type: 'Node2D', name: 'Extra', parentPath: '/root/Main' });
    const after = payload((await game.call('game_performance')).text) as Record<string, number>;
    expect(after.object_node_count).toBeGreaterThan(metrics.object_node_count);
  });

  it('game_get_logs and game_get_errors expose cursored engine output', async () => {
    const game = await startedGame({ privileged: true });

    // Drain whatever startup produced so the assertions below are about new output.
    await game.call('game_get_logs');
    await game.call('game_get_errors');

    await game.call('game_eval', { code: 'print("marker-alpha")\nreturn true' });
    await game.call('game_wait', { frames: 2 });

    const logs = await game.call('game_get_logs');
    expect(logs.isError, logs.text).toBe(false);
    expect(logs.text).toContain('marker-alpha');

    // The cursor advances: a second read does not repeat delivered lines.
    const repeat = await game.call('game_get_logs');
    expect(repeat.isError, repeat.text).toBe(false);
    expect(repeat.text).not.toContain('marker-alpha');

    await game.call('game_eval', { code: 'push_error("marker-boom")\nreturn true' });
    await game.call('game_wait', { frames: 2 });

    const errors = await game.call('game_get_errors');
    expect(errors.isError, errors.text).toBe(false);
    expect(errors.text).toContain('marker-boom');

    const drained = await game.call('game_get_errors');
    expect(drained.text).not.toContain('marker-boom');
  });

  it('game_get_logs returns bounded pages and reports unread output', async () => {
    const game = await startedGame({ privileged: true });
    await game.call('game_get_logs');
    const printed = await game.call('game_eval', { code: 'for i in range(8):\n\tprint("page-marker-%d" % i)\nreturn true' });
    expect(printed.isError, printed.text).toBe(false);
    await game.call('game_wait', { frames: 2 });

    const observed: string[] = [];
    let hasMore = true;
    for (let pageIndex = 0; pageIndex < 20 && hasMore; pageIndex++) {
      const page = await game.call('game_get_logs', { maxItems: 2 });
      expect(page.isError, page.text).toBe(false);
      const result = payload(page.text) as { count: number; logs: string[]; hasMore: boolean };
      expect(result.count).toBeLessThanOrEqual(2);
      observed.push(...result.logs);
      hasMore = result.hasMore;
    }
    expect(hasMore).toBe(false);
    for (let i = 0; i < 8; i++) expect(observed.join('\n')).toContain(`page-marker-${i}`);
  });

  it('game_get_ui enumerates live Control nodes', async () => {
    const game = await startedGame({ privileged: true });

    const bare = await game.call('game_get_ui');
    expect(bare.isError, bare.text).toBe(false);
    expect(bare.text).not.toContain('HealthBar');

    const spawned = await game.call('game_spawn_node', {
      type: 'Button', name: 'HealthBar', parentPath: '/root/Main',
      properties: { text: 'Play', position: { x: 4, y: 5 } },
    });
    expect(spawned.isError, spawned.text).toBe(false);

    // Independent observation: the UI enumeration picks up the new Control.
    const listed = await game.call('game_get_ui');
    expect(listed.isError, listed.text).toBe(false);
    const elements = (payload(listed.text) as { elements: { path?: string; type?: string; text?: string }[] }).elements;
    const button = elements.find(element => element.path === '/root/Main/HealthBar');
    expect(button, listed.text).toBeDefined();
    expect(button?.type).toBe('Button');
  });

  it('game_screenshot returns a decodable PNG or a structured headless limitation', async () => {
    const requireRenderedPixels = process.env.GODOT_MCP_RENDER_TEST === '1';
    const game = await startedGame({ privileged: requireRenderedPixels });

    const result = await game.call('game_screenshot');
    if (result.isError) {
      expect(requireRenderedPixels, result.text).toBe(false);
      // Headless uses a dummy renderer; the product must explain the limitation
      // rather than crash or return an empty payload.
      expect(result.text).toMatch(/screenshot|viewport|image|failed|limit/i);
      return;
    }
    const raw = result.raw as { content: { type: string; data?: string; mimeType?: string }[] };
    const image = raw.content.find(item => item.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    const png = Buffer.from(image?.data ?? '', 'base64');
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // IHDR width/height must match the live viewport, checked independently.
    const size = await engineEval(game, [
      'var r = get_viewport().get_visible_rect().size',
      'return [int(r.x), int(r.y)]',
    ].join('\n')) as number[];
    expect(png.readUInt32BE(16)).toBe(size[0]);
    expect(png.readUInt32BE(20)).toBe(size[1]);
    if (requireRenderedPixels) {
      const decoded = PNG.sync.read(png);
      const offset = (10 * decoded.width + 10) * 4;
      const actual = Array.from(decoded.data.subarray(offset, offset + 4));
      const expected = [51, 102, 153, 255];
      for (let channel = 0; channel < expected.length; channel++) {
        expect(Math.abs(actual[channel] - expected[channel]), `pixel channel ${channel}: ${actual}`).toBeLessThanOrEqual(8);
      }
      expect(await engineEval(game, 'return RenderingServer.get_current_rendering_method()'))
        .toBe(process.env.GODOT_MCP_E2E_RENDERER);
    }
  });

  it('game_visual_regression retains baseline, diff, tolerance, mask, and renderer evidence', async () => {
    const requireRenderedPixels = process.env.GODOT_MCP_RENDER_TEST === '1';
    const game = await startedGame({ privileged: true });
    const baseline = await game.call('game_visual_regression', {
      action: 'capture_baseline', baselinePath: 'artifacts/baseline.png',
    });
    if (baseline.isError) {
      expect(requireRenderedPixels, baseline.text).toBe(false);
      expect(baseline.text).toMatch(/screenshot|viewport|image|failed|limit/i);
      return;
    }
    const baselineResult = payload(baseline.text) as { width: number; height: number; renderer: object };
    expect(baselineResult.renderer).toEqual(expect.any(Object));
    if (process.env.GODOT_MCP_E2E_RENDERER) {
      expect(baselineResult.renderer).toMatchObject({ rendering_method: process.env.GODOT_MCP_E2E_RENDERER });
    }
    expect(existsSync(join(game.projectPath, 'artifacts', 'baseline.png'))).toBe(true);

    const equal = await game.call('game_visual_regression', {
      action: 'compare', baselinePath: 'artifacts/baseline.png',
      channelTolerance: 8, maxDifferentPixelRatio: 0,
    });
    expect(equal.isError, equal.text).toBe(false);
    expect(payload(equal.text)).toMatchObject({ passed: true, different_pixels: 0 });

    const changed = await game.call('game_set_property', {
      nodePath: '/root/Main/DeterministicBackground', property: 'color',
      value: { r: 0.8, g: 0.1, b: 0.1, a: 1 },
    });
    expect(changed.isError, changed.text).toBe(false);
    await game.call('game_wait', { frames: 2 });
    const different = await game.call('game_visual_regression', {
      action: 'compare', baselinePath: 'artifacts/baseline.png',
      diffArtifactPath: 'artifacts/diff.png', channelTolerance: 8,
      maxDifferentPixelRatio: 0,
    });
    expect(different.isError).toBe(true);
    expect(payload(different.text)).toMatchObject({ passed: false, diff_artifact_path: 'artifacts/diff.png' });
    expect(existsSync(join(game.projectPath, 'artifacts', 'diff.png'))).toBe(true);
    expect(PNG.sync.read(readFileSync(join(game.projectPath, 'artifacts', 'diff.png'))).width)
      .toBe(baselineResult.width);

    const mask = new PNG({ width: baselineResult.width, height: baselineResult.height });
    mask.data.fill(0);
    writeFileSync(join(game.projectPath, 'artifacts', 'mask.png'), PNG.sync.write(mask));
    const masked = await game.call('game_visual_regression', {
      action: 'compare', baselinePath: 'artifacts/baseline.png',
      maskPath: 'artifacts/mask.png', channelTolerance: 0,
      maxDifferentPixelRatio: 0,
    });
    expect(masked.isError, masked.text).toBe(false);
    expect(payload(masked.text)).toMatchObject({ passed: true, compared_pixels: 0 });
  });
});
