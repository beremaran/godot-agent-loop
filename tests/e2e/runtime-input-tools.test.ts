// @test-kind: e2e
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type E2EServer } from './helpers/harness.js';

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

async function startedGame(): Promise<E2EServer> {
  server = await startServer({ allowPrivileged: true });
  const started = await server.call('run_project', { projectPath: server.projectPath });
  expect(started.isError, started.text).toBe(false);
  await server.waitForGameConnection();
  return server;
}

async function evalResult(game: E2EServer, code: string): Promise<unknown> {
  const result = await game.call('game_eval', { code });
  expect(result.isError, result.text).toBe(false);
  return (payload(result.text) as { result: unknown }).result;
}

async function groupContains(game: E2EServer, group: string, path = '/root/Main'): Promise<boolean> {
  const result = await game.call('game_get_nodes_in_group', { group });
  expect(result.isError, result.text).toBe(false);
  return result.text.includes(path);
}

describe('runtime G+ input tools through MCP', () => {
  it('game_click and game_mouse_drag deliver press, motion, mask, and release events', async () => {
    const game = await startedGame();
    const clicked = await game.call('game_click', { x: 12, y: 34, button: 2 });
    expect(clicked.isError, clicked.text).toBe(false);
    expect(await groupContains(game, 'mouse-button-2-pressed-12-34')).toBe(true);
    expect(await groupContains(game, 'mouse-button-2-released-12-34')).toBe(true);
    expect(await evalResult(game, 'return Input.is_mouse_button_pressed(MOUSE_BUTTON_RIGHT)')).toBe(false);

    const dragged = await game.call('game_mouse_drag', {
      fromX: 2, fromY: 3, toX: 42, toY: 23, button: 2, steps: 4,
    });
    expect(dragged.isError, dragged.text).toBe(false);
    expect(await groupContains(game, 'mouse-motion-42-23-mask-2')).toBe(true);
    expect(await groupContains(game, 'mouse-button-2-released-42-23')).toBe(true);
    expect(await evalResult(game, 'return Input.is_mouse_button_pressed(MOUSE_BUTTON_RIGHT)')).toBe(false);

    const invalid = await game.call('game_mouse_drag', {
      fromX: 0, fromY: 0, toX: 1, toY: 1, button: 4,
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toMatch(/pressable mouse button/i);
  });

  it('game_input_action covers every action and cleans strength state', async () => {
    const game = await startedGame();
    const actionName = 'e2e_input_action';
    const add = { action: 'add_action', actionName, key: 'P' };
    expect((await game.call('game_input_action', add)).isError).toBe(false);
    expect((await game.call('game_input_action', add)).isError).toBe(false);
    expect(await evalResult(game, `return InputMap.action_get_events("${actionName}").size()`)).toBe(1);

    const listed = await game.call('game_input_action', { action: 'list' });
    expect(listed.isError, listed.text).toBe(false);
    expect(listed.text).toContain(actionName);

    const strength = await game.call('game_input_action', {
      action: 'set_strength', actionName, strength: 0.4,
    });
    expect(strength.isError, strength.text).toBe(false);
    expect(await evalResult(game, `return Input.get_action_strength("${actionName}")`)).toBeCloseTo(0.4);

    expect((await game.call('game_input_action', {
      action: 'set_strength', actionName, strength: 0,
    })).isError).toBe(false);
    expect(await evalResult(game, `return Input.is_action_pressed("${actionName}")`)).toBe(false);

    const missing = await game.call('game_input_action', {
      action: 'set_strength', actionName: 'missing_e2e_action', strength: 1,
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/action not found/i);

    const removed = await game.call('game_input_action', { action: 'remove_action', actionName });
    expect(removed.isError, removed.text).toBe(false);
    expect(await evalResult(game, `return InputMap.has_action("${actionName}")`)).toBe(false);
  });

  it('game_key_hold/release cover physical keys and actions without stuck state', async () => {
    const game = await startedGame();
    const actionName = 'e2e_held_action';
    await game.call('game_input_action', { action: 'add_action', actionName });

    expect((await game.call('game_key_hold', { action: actionName })).isError).toBe(false);
    expect(await evalResult(game, `return Input.is_action_pressed("${actionName}")`)).toBe(true);
    expect((await game.call('game_key_release', { action: actionName })).isError).toBe(false);
    expect(await evalResult(game, `return Input.is_action_pressed("${actionName}")`)).toBe(false);

    expect((await game.call('game_key_hold', { key: 'W' })).isError).toBe(false);
    expect(await groupContains(game, 'key-W-pressed')).toBe(true);
    expect(await evalResult(game, 'return Input.is_key_pressed(KEY_W)')).toBe(true);
    expect((await game.call('game_key_release', { key: 'W' })).isError).toBe(false);
    expect(await groupContains(game, 'key-W-released')).toBe(true);
    expect(await evalResult(game, 'return Input.is_key_pressed(KEY_W)')).toBe(false);

    const ambiguous = await game.call('game_key_hold', { key: 'W', action: actionName });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toMatch(/exactly one/i);
  });

  it('key press, mouse move, scroll, gamepad, and touch deliver typed events and release state', async () => {
    const game = await startedGame();
    expect((await game.call('game_key_press', {
      key: 'K', shift: true, ctrl: true,
    })).isError).toBe(false);
    expect(await groupContains(game, 'key-detail-K-physical--pressed-shift-true-ctrl-true-alt-false-meta-false-unicode-0')).toBe(true);
    expect(await groupContains(game, 'key-K-released')).toBe(true);
    expect(await evalResult(game, 'return Input.is_key_pressed(KEY_K)')).toBe(false);

    expect((await game.call('game_key_press', { key: 'W', physical: true })).isError).toBe(false);
    expect(await groupContains(game, 'key-detail--physical-W-pressed-shift-false-ctrl-false-alt-false-meta-false-unicode-0')).toBe(true);
    expect((await game.call('game_key_press', { text: '\u03a9', alt: true })).isError).toBe(false);
    const unicodeGroups = await evalResult(game, [
      'var groups: Array = []',
      'for group: StringName in get_tree().root.get_node("Main").get_groups():',
      '\tif str(group).begins_with("key-unicode-"):',
      '\t\tgroups.append(str(group))',
      'return groups',
    ].join('\n')) as string[];
    expect(unicodeGroups.join('|')).toContain('key-unicode-937-pressed-alt-true');

    const actionName = 'e2e_key_press_action';
    await game.call('game_input_action', { action: 'add_action', actionName });
    expect((await game.call('game_key_press', { action: actionName })).isError).toBe(false);
    expect(await evalResult(game, `return Input.is_action_pressed("${actionName}")`)).toBe(false);

    expect((await game.call('game_mouse_move', {
      x: 31, y: 41, relative_x: -3, relative_y: 5,
    })).isError).toBe(false);
    expect(await groupContains(game, 'mouse-motion-31-41-mask-0')).toBe(true);
    expect(await groupContains(game, 'mouse-relative--3-5')).toBe(true);
    for (const [direction, button] of [['up', 4], ['down', 5], ['left', 6], ['right', 7]] as const) {
      expect((await game.call('game_scroll', { x: 9, y: 10, direction, amount: 2 })).isError).toBe(false);
      expect(await groupContains(game, `mouse-button-${button}-pressed-9-10`)).toBe(true);
      expect(await groupContains(game, `mouse-wheel-${button}-released-factor-1.0`)).toBe(true);
    }

    expect((await game.call('game_gamepad', {
      type: 'button', device: 2, index: 1, value: 0.75,
    })).isError).toBe(false);
    expect(await groupContains(game, 'joy-button-2-1-true-pressure-0.75')).toBe(true);
    expect((await game.call('game_gamepad', {
      type: 'button', device: 2, index: 1, value: 0,
    })).isError).toBe(false);
    const deadzoned = await game.call('game_gamepad', {
      type: 'axis', device: 2, index: 1, value: 0.05, deadzone: 0.1,
    });
    expect(payload(deadzoned.text)).toMatchObject({ value: 0, raw_value: expect.closeTo(0.05, 5) });
    expect(await groupContains(game, 'joy-axis-2-1-value-0.0')).toBe(true);
    expect((await game.call('game_gamepad', {
      type: 'axis', device: 2, index: 1, value: -0.5,
    })).isError).toBe(false);
    expect(await groupContains(game, 'joy-axis-2-1-value--0.5')).toBe(true);
    await game.call('game_gamepad', { type: 'axis', device: 2, index: 1, value: 0 });

    expect((await game.call('game_touch', { action: 'press', x: 11, y: 12, index: 1 })).isError).toBe(false);
    expect((await game.call('game_touch', { action: 'press', x: 21, y: 22, index: 2 })).isError).toBe(false);
    expect(await groupContains(game, 'touch-1-true-11-12')).toBe(true);
    expect(await groupContains(game, 'touch-2-true-21-22')).toBe(true);
    expect((await game.call('game_touch', { action: 'release', x: 11, y: 12, index: 1 })).isError).toBe(false);
    expect((await game.call('game_touch', {
      action: 'drag', x: 21, y: 22, toX: 41, toY: 42, index: 2, steps: 2,
    })).isError).toBe(false);
    expect(await groupContains(game, 'touch-drag-2-41-42')).toBe(true);
    expect(await groupContains(game, 'touch-2-false-41-42')).toBe(true);

    const invalidAxis = await game.call('game_gamepad', { type: 'axis', index: 15, value: 0 });
    expect(invalidAxis.isError).toBe(true);
    expect(invalidAxis.text).toMatch(/index is out of range/i);
    const ambiguousText = await game.call('game_key_press', { key: 'A', text: 'a' });
    expect(ambiguousText.isError).toBe(true);
    expect(ambiguousText.text).toMatch(/exactly one/i);
  });

  it('game_await_signal returns typed args, times out cleanly, and detects node deletion', async () => {
    const game = await startedGame();
    expect(await evalResult(game, [
      'var main := get_tree().root.get_node("Main")',
      'var timer := Timer.new()',
      'timer.one_shot = true',
      'timer.wait_time = 0.05',
      'main.add_child(timer)',
      'timer.timeout.connect(Callable(main, "emit_e2e_event").bind(42))',
      'timer.timeout.connect(timer.queue_free)',
      'timer.start()',
      'return true',
    ].join('\n'))).toBe(true);
    const received = await game.call('game_await_signal', {
      nodePath: '/root/Main', signalName: 'e2e_event', timeout: 1,
    });
    expect(received.isError, received.text).toBe(false);
    expect(payload(received.text)).toMatchObject({ signal_name: 'e2e_event', received: true, args: [42] });

    const timedOut = await game.call('game_await_signal', {
      nodePath: '/root/Main', signalName: 'e2e_event', timeout: 0.05,
    });
    expect(timedOut.isError).toBe(true);
    expect(timedOut.text).toMatch(/timed out/i);
    expect((await game.call('game_input_state')).isError).toBe(false);

    expect(await evalResult(game, [
      'var main := get_tree().root.get_node("Main")',
      'var timer := Timer.new()',
      'timer.one_shot = true',
      'timer.wait_time = 0.05',
      'main.add_child(timer)',
      'timer.timeout.connect(Callable(main, "free_anchor"))',
      'timer.timeout.connect(timer.queue_free)',
      'timer.start()',
      'return true',
    ].join('\n'))).toBe(true);
    const freed = await game.call('game_await_signal', {
      nodePath: '/root/Main/Anchor', signalName: 'renamed', timeout: 1,
    });
    expect(freed.isError).toBe(true);
    expect(freed.text).toMatch(/freed while awaiting/i);
  });

  it('game_input_state covers query, warp, mouse modes, defaults, and failures', async () => {
    const game = await startedGame();
    const initialMode = await evalResult(game, 'return Input.mouse_mode');
    expect(initialMode).toBe(0);
    const query = await game.call('game_input_state');
    expect(query.isError, query.text).toBe(false);
    expect(payload(query.text)).toMatchObject({
      success: true, connected_joypads: expect.any(Number), joypad_ids: expect.any(Array), mouse_mode: 'visible',
    });

    const actionName = 'e2e_state_action';
    await game.call('game_input_action', { action: 'add_action', actionName });
    await game.call('game_input_action', { action: 'set_strength', actionName, strength: 0.65 });
    await game.call('game_key_hold', { key: 'W' });
    await evalResult(game, [
      'var event := InputEventMouseButton.new()',
      'event.button_index = MOUSE_BUTTON_LEFT',
      'event.pressed = true',
      'Input.parse_input_event(event)',
      'return true',
    ].join('\n'));
    const active = await game.call('game_input_state', {
      action: 'query', keys: ['W', 'A'], actions: [actionName], mouseButtons: [1, 2],
    });
    expect(active.isError, active.text).toBe(false);
    expect(payload(active.text)).toMatchObject({
      keys: { W: { pressed: true, physical_pressed: true }, A: { pressed: false, physical_pressed: false } },
      actions: {
        [actionName]: {
          pressed: true, strength: expect.closeTo(0.65, 5), raw_strength: expect.closeTo(0.65, 5),
        },
      },
      mouse_buttons: { 1: true, 2: false },
    });
    await game.call('game_key_release', { key: 'W' });
    await game.call('game_input_action', { action: 'set_strength', actionName, strength: 0 });
    await evalResult(game, [
      'var event := InputEventMouseButton.new()',
      'event.button_index = MOUSE_BUTTON_LEFT',
      'event.pressed = false',
      'Input.parse_input_event(event)',
      'return true',
    ].join('\n'));
    expect(payload((await game.call('game_input_state', {
      keys: ['W'], actions: [actionName], mouseButtons: [1],
    })).text)).toMatchObject({
      keys: { W: { pressed: false, physical_pressed: false } },
      actions: { [actionName]: { pressed: false, strength: 0 } },
      mouse_buttons: { 1: false },
    });

    const warped = await game.call('game_input_state', { action: 'warp_mouse', x: 21, y: 22 });
    expect(warped.isError).toBe(true);
    expect(warped.text).toMatch(/headless display driver/i);

    const hidden = await game.call('game_input_state', { action: 'set_mouse_mode', mouseMode: 'hidden' });
    expect(hidden.isError).toBe(true);
    expect(hidden.text).toMatch(/headless display driver/i);
    for (const mouseMode of ['captured', 'confined'] as const) {
      const unsupported = await game.call('game_input_state', { action: 'set_mouse_mode', mouseMode });
      expect(unsupported.isError).toBe(true);
      expect(unsupported.text).toMatch(/headless display driver/i);
    }
    const restored = await game.call('game_input_state', {
      action: 'set_mouse_mode', mouseMode: 'visible',
    });
    expect(restored.isError, restored.text).toBe(false);

    await expect(game.client.callTool({
      name: 'game_input_state', arguments: { action: 'set_mouse_mode', mouseMode: 'invalid' },
    })).rejects.toThrow(/mouseMode.*visible/i);
    const missingCoords = await game.call('game_input_state', { action: 'warp_mouse', x: 1 });
    expect(missingCoords.isError).toBe(true);
    expect(missingCoords.text).toMatch(/y is required/i);
    const unknownKey = await game.call('game_input_state', { keys: ['NOT_A_KEY'] });
    expect(unknownKey.isError).toBe(true);
    expect(unknownKey.text).toMatch(/Unknown key/i);
    const unknownAction = await game.call('game_input_state', { actions: ['missing_state_action'] });
    expect(unknownAction.isError).toBe(true);
    expect(unknownAction.text).toMatch(/action not found/i);
    await game.call('game_input_action', { action: 'remove_action', actionName });
  });
});
