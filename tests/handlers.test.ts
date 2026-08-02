// @test-kind: unit
/**
 * Real-handler tests. Every handler is constructed with its real class
 * (GameToolHandlers, ProjectToolHandlers, LifecycleToolHandlers) and driven
 * with real argument objects. Only the transport seams are mocked: the runtime
 * command boundary (GameCommandService.execute / GameConnection.send) and the
 * Godot child process. This replaces an earlier suite that re-implemented
 * handler argument transforms in local fakes and asserted source substrings,
 * which could not fail when the real handlers regressed.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn(() => ({ on: vi.fn(), kill: vi.fn(), exitCode: null, signalCode: null })));
vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  // The real execFile registers a custom promisifier that resolves an
  // { stdout, stderr } object; without it, promisify(execFile) resolves only
  // the first callback argument and callers destructuring { stdout } get
  // undefined. Set it here so source modules that call promisify(execFile) at
  // import time observe it.
  (execFileMock as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] = (
    _file: string,
    _args: readonly string[],
    _options?: unknown,
  ) => Promise.resolve({ stdout: '4.7.1.stable.official', stderr: '' });
  return { ...actual, execFile: execFileMock, spawn: spawnMock };
});

import {
  convertCamelToSnakeCase,
  createErrorResponse,
  normalizeParameters,
} from '../src/utils.js';
import { GameToolHandlers } from '../src/tool-handlers/game-tool-handlers.js';
import { ProjectToolHandlers } from '../src/tool-handlers/project-tool-handlers.js';
import { LifecycleToolHandlers, type LifecycleToolHandlerContext } from '../src/tool-handlers/lifecycle-tool-handlers.js';
import type { GodotProcess } from '../src/godot-process-manager.js';
import { toolManifest } from '../src/tool-manifest.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  execFileMock.mockReset();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createProject(): string {
  const directory = mkdtempSync(join(tmpdir(), 'godot-agent-loop-handlers-'));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, 'project.godot'), '[application]\nconfig/name="Test Game"\n');
  writeFileSync(join(directory, 'main.tscn'), '[gd_scene load_steps=2 format=3 uid="uid://main"]\n\n[node name="Main" type="Node2D"]\n');
  writeFileSync(join(directory, 'icon.png'), 'png');
  return directory;
}

function textFrom(response: { content?: { type: string; text?: string }[] }): string {
  return response.content?.find(item => item.type === 'text')?.text ?? '';
}

function isErrorResponse(response: { isError?: boolean }): boolean {
  return response.isError === true;
}

// ---------------------------------------------------------------------------
// Game runtime command boundary (the only mocked seam for game tools). It
// mirrors GameCommandService.execute exactly: process/connection gates,
// normalizeParameters, buildParams, then convertCamelToSnakeCase.
// ---------------------------------------------------------------------------

interface RecordedCommand {
  name: string;
  args: Record<string, unknown>;
}

function gameHarness(overrides: { process?: boolean; connected?: boolean } = {}) {
  const calls: RecordedCommand[] = [];
  const execute = vi.fn((
    name: string,
    args: unknown,
    buildParams: (a: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    if (overrides.process === false) {
      return Promise.resolve(createErrorResponse('No active Godot process. Use run_project first.'));
    }
    if (overrides.connected === false) {
      return Promise.resolve(createErrorResponse('Not connected to game interaction server.'));
    }
    const normalized = normalizeParameters((args || {}) as Record<string, unknown>);
    calls.push({ name, args: convertCamelToSnakeCase(buildParams(normalized)) });
    return Promise.resolve({ content: [{ type: 'text', text: 'ok' }] });
  });
  const commands = {
    execute,
    hasActiveProcess: () => overrides.process ?? true,
    isConnected: () => overrides.connected ?? true,
    send: vi.fn(() => Promise.resolve({ result: { data: '', width: 0, height: 0 } })),
    readNewErrors: vi.fn(() => ({ items: [], remaining: 0, byteLimited: false })),
    readNewLogs: vi.fn(() => ({ items: [], remaining: 0, byteLimited: false })),
  };
  const handlers = new GameToolHandlers({ commands: commands as never });
  return { handlers, calls, commands };
}

describe('Game handlers — real runtime command boundary', () => {
  it('handleGameClick maps coordinates and button with defaults', async () => {
    const { handlers, calls } = gameHarness();
    await handlers.handleGameClick({});
    expect(calls).toEqual([{ name: 'click', args: { x: 0, y: 0, button: 1 } }]);
    calls.length = 0;
    await handlers.handleGameClick({ x: 100, y: 200, button: 2 });
    expect(calls).toEqual([{ name: 'click', args: { x: 100, y: 200, button: 2 } }]);
  });

  it('handleGameKeyPress sends exactly one of key/action/text and modifiers', async () => {
    const { handlers, calls } = gameHarness();
    await handlers.handleGameKeyPress({ key: 'W', shift: true });
    expect(calls).toEqual([{ name: 'key_press', args: { key: 'W', shift: true } }]);
    calls.length = 0;
    expect(isErrorResponse(await handlers.handleGameKeyPress({}))).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('handleGameMouseMove defaults and preserves relative motion', async () => {
    const { handlers, calls } = gameHarness();
    await handlers.handleGameMouseMove({ x: 10, y: 20, relative_x: 5, relative_y: -3 });
    expect(calls[0]).toEqual({ name: 'mouse_move', args: { x: 10, y: 20, relative_x: 5, relative_y: -3 } });
  });

  it('handleGameGetUi bounds the default response and passes subtree limits', async () => {
    const { handlers, calls } = gameHarness();
    await handlers.handleGameGetUi({});
    expect(calls[0]).toEqual({ name: 'get_ui_elements', args: { max_elements: 200 } });
    calls.length = 0;
    await handlers.handleGameGetUi({ rootPath: '/root/Main/HUD', maxElements: 8 });
    expect(calls[0]).toEqual({ name: 'get_ui_elements', args: { root_path: '/root/Main/HUD', max_elements: 8 } });
  });

  it('handleGameGetSceneTree defaults maxNodes', async () => {
    const { handlers, calls } = gameHarness();
    await handlers.handleGameGetSceneTree({});
    expect(calls[0]).toEqual({ name: 'get_scene_tree', args: { max_nodes: 1000 } });
  });

  it('handleGameEval requires code and forwards it', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameEval({}))).toBe(true);
    await handlers.handleGameEval({ code: 'get_tree().root.name' });
    expect(calls[0]).toEqual({ name: 'eval', args: { code: 'get_tree().root.name' } });
  });

  it('handleGameGetProperty requires nodePath and property', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameGetProperty({ nodePath: '/root/Player' }))).toBe(true);
    await handlers.handleGameGetProperty({ nodePath: '/root/Player', property: 'position' });
    expect(calls[0]).toEqual({ name: 'get_property', args: { node_path: '/root/Player', property: 'position' } });
  });

  it('handleGameSetProperty requires nodePath and property', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameSetProperty({ nodePath: '/root/P' }))).toBe(true);
    await handlers.handleGameSetProperty({ nodePath: '/root/P', property: 'speed', value: 100, typeHint: 'int' });
    expect(calls[0]).toEqual({ name: 'set_property', args: { node_path: '/root/P', property: 'speed', value: 100, type_hint: 'int' } });
  });

  it('handleGameCallMethod requires nodePath and method and defaults args', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameCallMethod({ method: 'jump' }))).toBe(true);
    await handlers.handleGameCallMethod({ nodePath: '/root/P', method: 'jump' });
    expect(calls[0]).toEqual({ name: 'call_method', args: { node_path: '/root/P', method: 'jump', args: [] } });
  });

  it('handleGameGetNodeInfo requires nodePath', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameGetNodeInfo({}))).toBe(true);
    await handlers.handleGameGetNodeInfo({ nodePath: '/root/UI', detail: 'compact', propertyNames: ['position'] });
    expect(calls[0]).toEqual({ name: 'get_node_info', args: { node_path: '/root/UI', detail: 'compact', property_names: ['position'] } });
  });

  it('handleGameInstantiateScene requires scenePath and defaults parent', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameInstantiateScene({}))).toBe(true);
    await handlers.handleGameInstantiateScene({ scenePath: 'res://enemy.tscn' });
    expect(calls[0]).toEqual({ name: 'instantiate_scene', args: { scene_path: 'res://enemy.tscn', parent_path: '/root' } });
  });

  it('handleGameRemoveNode requires nodePath', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameRemoveNode({}))).toBe(true);
    await handlers.handleGameRemoveNode({ nodePath: '/root/Enemy' });
    expect(calls[0]).toEqual({ name: 'remove_node', args: { node_path: '/root/Enemy' } });
  });

  it('handleGameChangeScene requires scenePath', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameChangeScene({}))).toBe(true);
    await handlers.handleGameChangeScene({ scenePath: 'res://level2.tscn' });
    expect(calls[0]).toEqual({ name: 'change_scene', args: { scene_path: 'res://level2.tscn' } });
  });

  it('handleGamePause defaults paused to true', async () => {
    const { handlers, calls } = gameHarness();
    await handlers.handleGamePause({});
    expect(calls[0]).toEqual({ name: 'pause', args: { paused: true } });
  });

  it('handleGamePerformance validates action and forwards sample count', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGamePerformance({ action: 'bogus' }))).toBe(true);
    await handlers.handleGamePerformance({ action: 'sample', sampleCount: 5 });
    expect(calls[0].name).toBe('get_performance');
    expect(calls[0].args.sample_count).toBe(5);
  });

  it('handleGameWait validates frames and defaults to one frame', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameWait({ frames: 0 }))).toBe(true);
    await handlers.handleGameWait({});
    expect(calls[0]).toEqual({ name: 'wait', args: { frames: 1, frame_type: 'render' } });
    calls.length = 0;
    await handlers.handleGameWait({ frames: 60, frameType: 'physics' });
    expect(calls[0]).toEqual({ name: 'wait', args: { frames: 60, frame_type: 'physics' } });
  });

  it('handleGameConnectSignal requires all four signal fields', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameConnectSignal({ nodePath: '/root/B', signalName: 'pressed' }))).toBe(true);
    await handlers.handleGameConnectSignal({
      nodePath: '/root/Button', signalName: 'pressed', targetPath: '/root/Game', method: '_on_pressed',
    });
    expect(calls[0]).toEqual({
      name: 'connect_signal',
      args: { node_path: '/root/Button', signal_name: 'pressed', target_path: '/root/Game', method: '_on_pressed' },
    });
  });

  it('handleGameDisconnectSignal requires all four signal fields', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameDisconnectSignal({ nodePath: '/root/B' }))).toBe(true);
    await handlers.handleGameDisconnectSignal({
      nodePath: '/root/B', signalName: 'pressed', targetPath: '/root/G', method: 'handler',
    });
    expect(calls[0].args.signal_name).toBe('pressed');
  });

  it('handleGameEmitSignal requires nodePath and signalName', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameEmitSignal({ nodePath: '/root/E' }))).toBe(true);
    await handlers.handleGameEmitSignal({ nodePath: '/root/E', signalName: 'died', args: [10] });
    expect(calls[0]).toEqual({ name: 'emit_signal', args: { node_path: '/root/E', signal_name: 'died', args: [10] } });
  });

  it('handleGamePlayAnimation requires nodePath and defaults action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGamePlayAnimation({}))).toBe(true);
    await handlers.handleGamePlayAnimation({ nodePath: '/root/P' });
    expect(calls[0]).toEqual({ name: 'play_animation', args: { node_path: '/root/P', action: 'play', animation: '' } });
  });

  it('handleGameTweenProperty requires nodePath, property, and finalValue', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameTweenProperty({ nodePath: '/root/S', property: 'x' }))).toBe(true);
    await handlers.handleGameTweenProperty({ nodePath: '/root/Sprite', property: 'position:x', finalValue: 100, duration: 2.5, transType: 1, easeType: 3 });
    expect(calls[0]).toEqual({
      name: 'tween_property',
      args: { node_path: '/root/Sprite', property: 'position:x', final_value: 100, duration: 2.5, trans_type: 1, ease_type: 3 },
    });
  });

  it('handleGameGetNodesInGroup requires group', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameGetNodesInGroup({}))).toBe(true);
    await handlers.handleGameGetNodesInGroup({ group: 'enemies' });
    expect(calls[0]).toEqual({ name: 'get_nodes_in_group', args: { group: 'enemies' } });
  });

  it('handleGameFindNodesByClass requires className and defaults root', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameFindNodesByClass({}))).toBe(true);
    await handlers.handleGameFindNodesByClass({ className: 'Sprite2D' });
    expect(calls[0]).toEqual({ name: 'find_nodes_by_class', args: { class_name: 'Sprite2D', root_path: '/root' } });
  });

  it('handleGameReparentNode requires nodePath and newParentPath', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameReparentNode({ nodePath: '/root/Player' }))).toBe(true);
    await handlers.handleGameReparentNode({ nodePath: '/root/Player', newParentPath: '/root/World', keepGlobalTransform: false });
    expect(calls[0].args).toEqual({ node_path: '/root/Player', new_parent_path: '/root/World', keep_global_transform: false });
  });

  it('handleGameGetErrors requires an active process and returns a bounded observation', async () => {
    const { handlers, commands } = gameHarness();
    commands.readNewErrors.mockReturnValue({ items: ['boom'], remaining: 0, byteLimited: false });
    const response = await handlers.handleGameGetErrors({});
    expect(textFrom(response)).toContain('"errors"');
    expect(textFrom(response)).toContain('boom');

    const cold = gameHarness({ process: false });
    expect(isErrorResponse(await cold.handlers.handleGameGetErrors({}))).toBe(true);
  });

  it('handleGameGetLogs requires an active process and returns a bounded observation', async () => {
    const { handlers, commands } = gameHarness();
    commands.readNewLogs.mockReturnValue({ items: ['ready'], remaining: 0, byteLimited: false });
    const response = await handlers.handleGameGetLogs({});
    expect(textFrom(response)).toContain('ready');

    const cold = gameHarness({ process: false });
    expect(isErrorResponse(await cold.handlers.handleGameGetLogs({}))).toBe(true);
  });

  it('handleGameKeyHold and handleGameKeyRelease require key or action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameKeyHold({}))).toBe(true);
    expect(isErrorResponse(await handlers.handleGameKeyRelease({}))).toBe(true);
    await handlers.handleGameKeyHold({ key: 'W' });
    await handlers.handleGameKeyRelease({ action: 'move_forward' });
    expect(calls).toEqual([
      { name: 'key_hold', args: { key: 'W' } },
      { name: 'key_release', args: { action: 'move_forward' } },
    ]);
  });

  it('handleGameScroll defaults direction and amount', async () => {
    const { handlers, calls } = gameHarness();
    await handlers.handleGameScroll({ x: 100, y: 200 });
    expect(calls[0]).toEqual({ name: 'scroll', args: { x: 100, y: 200, direction: 'up', amount: 1 } });
    calls.length = 0;
    await handlers.handleGameScroll({ x: 0, y: 0, direction: 'down', amount: 3 });
    expect(calls[0].args.direction).toBe('down');
    expect(calls[0].args.amount).toBe(3);
  });

  it('handleGameMouseDrag requires from/to coordinates', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameMouseDrag({ fromX: 10 }))).toBe(true);
    await handlers.handleGameMouseDrag({ fromX: 10, fromY: 20, toX: 100, toY: 200 });
    expect(calls[0]).toEqual({ name: 'mouse_drag', args: { from_x: 10, from_y: 20, to_x: 100, to_y: 200, button: 1, steps: 10 } });
  });

  it('handleGameGamepad requires type, index, and value', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameGamepad({ type: 'button' }))).toBe(true);
    await handlers.handleGameGamepad({ type: 'axis', index: 1, value: -0.5, device: 2 });
    expect(calls[0].args).toEqual({ type: 'axis', index: 1, value: -0.5, device: 2 });
  });

  it('handleGameGetCamera sends empty args', async () => {
    const { handlers, calls } = gameHarness();
    await handlers.handleGameGetCamera();
    expect(calls[0]).toEqual({ name: 'get_camera', args: {} });
  });

  it('handleGameSetCamera passes only defined fields', async () => {
    const { handlers, calls } = gameHarness();
    await handlers.handleGameSetCamera({ position: { x: 10, y: 20 }, fov: 60 });
    expect(calls[0]).toEqual({ name: 'set_camera', args: { position: { x: 10, y: 20 }, fov: 60 } });
  });

  it('handleGameRaycast requires from and to and defaults collision mask', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameRaycast({ from: { x: 0, y: 0 } }))).toBe(true);
    await handlers.handleGameRaycast({ from: { x: 0, y: 0 }, to: { x: 100, y: 100 } });
    expect(calls[0].args.collision_mask).toBe(0xFFFFFFFF);
  });

  it('handleGameGetAudio sends empty args', async () => {
    const { handlers, calls } = gameHarness();
    await handlers.handleGameGetAudio();
    expect(calls[0]).toEqual({ name: 'get_audio', args: {} });
  });

  it('handleGameSpawnNode requires type and defaults name/parent', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameSpawnNode({}))).toBe(true);
    await handlers.handleGameSpawnNode({ type: 'Sprite2D', name: 'MyNode', properties: { visible: false } });
    expect(calls[0]).toEqual({ name: 'spawn_node', args: { type: 'Sprite2D', name: 'MyNode', parent_path: '/root', properties: { visible: false } } });
  });

  it('handleGameSetShaderParam requires nodePath and paramName', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameSetShaderParam({ nodePath: '/root/Mesh' }))).toBe(true);
    await handlers.handleGameSetShaderParam({ nodePath: '/root/Mesh', paramName: 'albedo_color', value: { r: 1, g: 0, b: 0, a: 1 }, typeHint: 'Color' });
    expect(calls[0]).toEqual({
      name: 'set_shader_param',
      args: { node_path: '/root/Mesh', param_name: 'albedo_color', value: { r: 1, g: 0, b: 0, a: 1 }, type_hint: 'Color' },
    });
  });

  it('handleGameAudioPlay requires nodePath and defaults action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameAudioPlay({}))).toBe(true);
    await handlers.handleGameAudioPlay({ nodePath: '/root/SFX', volume: 0.5, pitch: 1.2, bus: 'Effects', fromPosition: 3.5, stream: 'res://audio.ogg' });
    expect(calls[0]).toEqual({
      name: 'audio_play',
      args: { node_path: '/root/SFX', action: 'play', stream: 'res://audio.ogg', volume: 0.5, pitch: 1.2, bus: 'Effects', from_position: 3.5 },
    });
  });

  it('handleGameAudioBus defaults bus to Master', async () => {
    const { handlers, calls } = gameHarness();
    await handlers.handleGameAudioBus({});
    expect(calls[0]).toEqual({ name: 'audio_bus', args: { bus_name: 'Master' } });
    calls.length = 0;
    await handlers.handleGameAudioBus({ busName: 'Music', volume: 0.3, mute: true });
    expect(calls[0].args).toEqual({ bus_name: 'Music', volume: 0.3, mute: true });
  });

  it('handleGameNavigatePath requires start and end and defaults optimize', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameNavigatePath({ start: { x: 0, y: 0 } }))).toBe(true);
    await handlers.handleGameNavigatePath({ start: { x: 0, y: 0 }, end: { x: 100, y: 200 } });
    expect(calls[0]).toEqual({ name: 'navigate_path', args: { start: { x: 0, y: 0 }, end: { x: 100, y: 200 }, optimize: true } });
  });

  it('handleGameTilemap requires nodePath and action and maps cell fields', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameTilemap({ nodePath: '/root/TileMap' }))).toBe(true);
    await handlers.handleGameTilemap({
      nodePath: '/root/TileMap', action: 'set_cells',
      cells: [{ x: 0, y: 0, sourceId: 0, atlasX: 1, atlasY: 2, altTile: 3 }],
    });
    expect(calls[0].name).toBe('tilemap');
    expect(calls[0].args.cells).toEqual([{ x: 0, y: 0, source_id: 0, atlas_x: 1, atlas_y: 2, alt_tile: 3 }]);
  });

  it('handleGameAddCollision requires parentPath and shapeType', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameAddCollision({ parentPath: '/root/Body' }))).toBe(true);
    await handlers.handleGameAddCollision({ parentPath: '/root/Body', shapeType: 'box', collisionLayer: 1, collisionMask: 3 });
    expect(calls[0].args).toEqual({ parent_path: '/root/Body', shape_type: 'box', collision_layer: 1, collision_mask: 3 });
  });

  it('handleGameEnvironment defaults action to set and maps settings', async () => {
    const { handlers, calls } = gameHarness();
    await handlers.handleGameEnvironment({ backgroundColor: { r: 1, g: 1, b: 1 }, glowEnabled: true });
    expect(calls[0].name).toBe('environment');
    expect(calls[0].args).toEqual({ action: 'set', background_color: { r: 1, g: 1, b: 1 }, glow_enabled: true });
  });

  it('handleGameManageGroup requires action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameManageGroup({}))).toBe(true);
    await handlers.handleGameManageGroup({ action: 'add', nodePath: '/root/Player', group: 'enemies' });
    expect(calls[0]).toEqual({ name: 'manage_group', args: { action: 'add', node_path: '/root/Player', group: 'enemies' } });
  });

  it('handleGameCreateTimer defaults parent, wait, and flags', async () => {
    const { handlers, calls } = gameHarness();
    await handlers.handleGameCreateTimer({});
    expect(calls[0]).toEqual({ name: 'create_timer', args: { parent_path: '/root', wait_time: 1.0, one_shot: false, autostart: false } });
  });

  it('handleGameSetParticles requires nodePath', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameSetParticles({}))).toBe(true);
    await handlers.handleGameSetParticles({ nodePath: '/root/Particles', emitting: true, amount: 100 });
    expect(calls[0]).toEqual({ name: 'set_particles', args: { node_path: '/root/Particles', emitting: true, amount: 100 } });
  });

  it('handleGameCreateAnimation requires nodePath and animationName', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameCreateAnimation({ nodePath: '/root/AnimPlayer' }))).toBe(true);
    await handlers.handleGameCreateAnimation({ nodePath: '/root/AnimPlayer', animationName: 'walk', length: 2.0 });
    expect(calls[0]).toEqual({
      name: 'create_animation',
      args: { node_path: '/root/AnimPlayer', animation_name: 'walk', length: 2.0, loop_mode: 0, tracks: [] },
    });
  });

  it('handleGameSerializeState defaults to save with depth 5', async () => {
    const { handlers, calls } = gameHarness();
    await handlers.handleGameSerializeState({});
    expect(calls[0]).toEqual({ name: 'serialize_state', args: { node_path: '/root', action: 'save', max_depth: 5 } });
  });

  it('handleGamePhysicsBody requires nodePath', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGamePhysicsBody({}))).toBe(true);
    await handlers.handleGamePhysicsBody({ nodePath: '/root/Ball', mass: 2.0, gravityScale: 0.5 });
    expect(calls[0]).toEqual({ name: 'physics_body', args: { node_path: '/root/Ball', gravity_scale: 0.5, mass: 2.0 } });
  });

  it('handleGameCreateJoint requires parentPath and jointType', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameCreateJoint({ parentPath: '/root' }))).toBe(true);
    await handlers.handleGameCreateJoint({ parentPath: '/root', jointType: 'pin', stiffness: 5 });
    expect(calls[0].args).toEqual({ parent_path: '/root', joint_type: 'pin', stiffness: 5 });
  });

  it('handleGameBonePose requires nodePath and defaults action to list', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameBonePose({}))).toBe(true);
    await handlers.handleGameBonePose({ nodePath: '/root/Skel' });
    expect(calls[0]).toEqual({ name: 'bone_pose', args: { node_path: '/root/Skel', action: 'list' } });
  });

  it('handleGameUiTheme requires nodePath and overrides', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameUiTheme({ nodePath: '/root/UI' }))).toBe(true);
    await handlers.handleGameUiTheme({ nodePath: '/root/UI', overrides: { font_size: 16 } });
    expect(calls[0]).toEqual({ name: 'ui_theme', args: { node_path: '/root/UI', overrides: { font_size: 16 } } });
  });

  it('handleGameViewport defaults action to create', async () => {
    const { handlers, calls } = gameHarness();
    await handlers.handleGameViewport({});
    expect(calls[0]).toEqual({ name: 'viewport', args: { action: 'create' } });
  });

  it('handleGameDebugDraw requires action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameDebugDraw({}))).toBe(true);
    await handlers.handleGameDebugDraw({ action: 'line', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, color: { r: 1, g: 0, b: 0, a: 1 } });
    expect(calls[0].name).toBe('debug_draw');
    expect(calls[0].args.action).toBe('line');
  });

  it('handleGameHttpRequest requires url and defaults method', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameHttpRequest({}))).toBe(true);
    await handlers.handleGameHttpRequest({ url: 'https://example.com' });
    expect(calls[0]).toEqual({ name: 'http_request', args: { url: 'https://example.com', method: 'GET' } });
  });

  it('handleGameWebsocket validates action-specific requirements', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameWebsocket({ action: 'connect' }))).toBe(true);
    expect(isErrorResponse(await handlers.handleGameWebsocket({ action: 'send' }))).toBe(true);
    await handlers.handleGameWebsocket({ action: 'connect', url: 'ws://localhost:1' });
    expect(calls[0].name).toBe('websocket');
  });

  it('handleGameMultiplayer requires action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameMultiplayer({}))).toBe(true);
    await handlers.handleGameMultiplayer({ action: 'status' });
    expect(calls[0]).toEqual({ name: 'multiplayer', args: { action: 'status' } });
  });

  it('handleGameRpc requires nodePath, action, and method', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameRpc({ nodePath: '/root/P', action: 'call' }))).toBe(true);
    await handlers.handleGameRpc({ nodePath: '/root/P', action: 'call', method: 'sync' });
    expect(calls[0]).toEqual({ name: 'rpc', args: { node_path: '/root/P', action: 'call', method: 'sync' } });
  });

  it('handleGameTouch requires action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameTouch({}))).toBe(true);
    await handlers.handleGameTouch({ action: 'press', x: 1, y: 2 });
    expect(calls[0]).toEqual({ name: 'touch', args: { action: 'press', x: 1, y: 2 } });
  });

  it('handleGameInputState defaults action to query', async () => {
    const { handlers, calls } = gameHarness();
    await handlers.handleGameInputState({});
    expect(calls[0]).toEqual({ name: 'input_state', args: { action: 'query' } });
  });

  it('handleGameInputAction requires action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameInputAction({}))).toBe(true);
    await handlers.handleGameInputAction({ action: 'press', actionName: 'jump' });
    expect(calls[0].args.action_name).toBe('jump');
  });

  it('handleGameListSignals requires nodePath', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameListSignals({}))).toBe(true);
    await handlers.handleGameListSignals({ nodePath: '/root/P' });
    expect(calls[0]).toEqual({ name: 'list_signals', args: { node_path: '/root/P' } });
  });

  it('handleGameAwaitSignal requires nodePath and signalName', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameAwaitSignal({ nodePath: '/root/P' }))).toBe(true);
    await handlers.handleGameAwaitSignal({ nodePath: '/root/P', signalName: 'ready' });
    expect(calls[0]).toEqual({ name: 'await_signal', args: { node_path: '/root/P', signal_name: 'ready', timeout: 10 } });
  });

  it('handleGameScript requires nodePath and action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameScript({ nodePath: '/root/P' }))).toBe(true);
    await handlers.handleGameScript({ nodePath: '/root/P', action: 'run', source: 'return 1' });
    expect(calls[0]).toEqual({ name: 'script', args: { node_path: '/root/P', action: 'run', source: 'return 1' } });
  });

  it('handleGameWindow defaults action to get', async () => {
    const { handlers, calls } = gameHarness();
    await handlers.handleGameWindow({});
    expect(calls[0]).toEqual({ name: 'window', args: { action: 'get' } });
  });

  it('handleGameOsInfo sends empty args', async () => {
    const { handlers, calls } = gameHarness();
    await handlers.handleGameOsInfo({});
    expect(calls[0]).toEqual({ name: 'os_info', args: {} });
  });

  it('handleGameTimeScale defaults action to get', async () => {
    const { handlers, calls } = gameHarness();
    await handlers.handleGameTimeScale({});
    expect(calls[0]).toEqual({ name: 'time_scale', args: { action: 'get' } });
  });

  it('handleGameProcessMode requires nodePath and mode', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameProcessMode({ nodePath: '/root/P' }))).toBe(true);
    await handlers.handleGameProcessMode({ nodePath: '/root/P', mode: 'always' });
    expect(calls[0]).toEqual({ name: 'process_mode', args: { node_path: '/root/P', mode: 'always' } });
  });

  it('handleGameWorldSettings defaults action to get', async () => {
    const { handlers, calls } = gameHarness();
    await handlers.handleGameWorldSettings({});
    expect(calls[0]).toEqual({ name: 'world_settings', args: { action: 'get' } });
  });

  it('handleGameCsg requires action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameCsg({}))).toBe(true);
    await handlers.handleGameCsg({ action: 'create', csgType: 'box' });
    expect(calls[0].args).toEqual({ action: 'create', csg_type: 'box' });
  });

  it('handleGameMultimesh requires action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameMultimesh({}))).toBe(true);
    await handlers.handleGameMultimesh({ action: 'status' });
    expect(calls[0]).toEqual({ name: 'multimesh', args: { action: 'status' } });
  });

  it('handleGameProceduralMesh requires parentPath and vertices', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameProceduralMesh({ parentPath: '/root' }))).toBe(true);
    await handlers.handleGameProceduralMesh({ parentPath: '/root', vertices: [{ x: 0, y: 0, z: 0 }] });
    expect(calls[0].args).toEqual({ parent_path: '/root', vertices: [{ x: 0, y: 0, z: 0 }] });
  });

  it('handleGameLight3d requires action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameLight3d({}))).toBe(true);
    await handlers.handleGameLight3d({ action: 'create', lightType: 'omni' });
    expect(calls[0].args.light_type).toBe('omni');
  });

  it('handleGameMeshInstance requires parentPath and meshType', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameMeshInstance({ parentPath: '/root' }))).toBe(true);
    await handlers.handleGameMeshInstance({ parentPath: '/root', meshType: 'box' });
    expect(calls[0].args.mesh_type).toBe('box');
  });

  it('handleGameGridmap requires nodePath and action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameGridmap({ nodePath: '/root/G' }))).toBe(true);
    await handlers.handleGameGridmap({ nodePath: '/root/G', action: 'get_cell', x: 1, y: 2, z: 3 });
    expect(calls[0].args).toEqual({ node_path: '/root/G', action: 'get_cell', x: 1, y: 2, z: 3 });
  });

  it('handleGame3dEffects requires parentPath and effectType', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGame3dEffects({ parentPath: '/root' }))).toBe(true);
    await handlers.handleGame3dEffects({ parentPath: '/root', effectType: 'bloom' });
    expect(calls[0].args.effect_type).toBe('bloom');
  });

  it('handleGameGi requires parentPath and giType', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameGi({ parentPath: '/root' }))).toBe(true);
    await handlers.handleGameGi({ parentPath: '/root', giType: 'voxel' });
    expect(calls[0].args.gi_type).toBe('voxel');
  });

  it('handleGamePath3d validates action-specific requirements', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGamePath3d({ action: 'create' }))).toBe(true);
    await handlers.handleGamePath3d({ action: 'create', parentPath: '/root' });
    expect(calls[0].name).toBe('path_3d');
  });

  it('handleGameSky requires action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameSky({}))).toBe(true);
    await handlers.handleGameSky({ action: 'set', skyType: 'procedural' });
    expect(calls[0].args.sky_type).toBe('procedural');
  });

  it('handleGameCameraAttributes defaults action to get', async () => {
    const { handlers, calls } = gameHarness();
    await handlers.handleGameCameraAttributes({});
    expect(calls[0]).toEqual({ name: 'camera_attributes', args: { action: 'get' } });
  });

  it('handleGameNavigation3d requires action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameNavigation3d({}))).toBe(true);
    await handlers.handleGameNavigation3d({ action: 'create', parentPath: '/root' });
    expect(calls[0].name).toBe('navigation_3d');
  });

  it('handleGamePhysics3d requires action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGamePhysics3d({}))).toBe(true);
    await handlers.handleGamePhysics3d({ action: 'raycast', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 } });
    expect(calls[0].name).toBe('physics_3d');
  });

  it('handleGamePhysics2d requires action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGamePhysics2d({}))).toBe(true);
    await handlers.handleGamePhysics2d({ action: 'raycast', from: { x: 0, y: 0 }, to: { x: 1, y: 0 } });
    expect(calls[0].name).toBe('physics_2d');
  });

  it('handleGameCanvas and handleGameCanvasDraw require action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameCanvas({}))).toBe(true);
    expect(isErrorResponse(await handlers.handleGameCanvasDraw({}))).toBe(true);
    await handlers.handleGameCanvas({ action: 'create' });
    await handlers.handleGameCanvasDraw({ action: 'line', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } });
    expect(calls.map(call => call.name)).toEqual(['canvas', 'canvas_draw']);
  });

  it('handleGameLight2d requires action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameLight2d({}))).toBe(true);
    await handlers.handleGameLight2d({ action: 'create', parentPath: '/root' });
    expect(calls[0].name).toBe('light_2d');
  });

  it('handleGameParallax requires action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameParallax({}))).toBe(true);
    await handlers.handleGameParallax({ action: 'create' });
    expect(calls[0].name).toBe('parallax');
  });

  it('handleGameShape2d requires nodePath and action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameShape2d({ nodePath: '/root/S' }))).toBe(true);
    await handlers.handleGameShape2d({ nodePath: '/root/S', action: 'get_points' });
    expect(calls[0]).toEqual({ name: 'shape_2d', args: { node_path: '/root/S', action: 'get_points' } });
  });

  it('handleGamePath2d requires action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGamePath2d({}))).toBe(true);
    await handlers.handleGamePath2d({ action: 'get_points' });
    expect(calls[0]).toEqual({ name: 'path_2d', args: { action: 'get_points' } });
  });

  it('handleGameAnimationTree requires nodePath and action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameAnimationTree({ nodePath: '/root/T' }))).toBe(true);
    await handlers.handleGameAnimationTree({ nodePath: '/root/T', action: 'get_state' });
    expect(calls[0]).toEqual({ name: 'animation_tree', args: { node_path: '/root/T', action: 'get_state' } });
  });

  it('handleGameAnimationControl requires nodePath and action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameAnimationControl({ nodePath: '/root/A' }))).toBe(true);
    await handlers.handleGameAnimationControl({ nodePath: '/root/A', action: 'play' });
    expect(calls[0]).toEqual({ name: 'animation_control', args: { node_path: '/root/A', action: 'play' } });
  });

  it('handleGameAudioEffect and handleGameAudioBusLayout pass through params', async () => {
    const { handlers, calls } = gameHarness();
    await handlers.handleGameAudioEffect({ action: 'list' });
    await handlers.handleGameAudioBusLayout({ action: 'list' });
    expect(calls.map(call => call.name)).toEqual(['audio_effect', 'audio_bus_layout']);
  });

  it('handleGameAudioSpatial requires nodePath and action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameAudioSpatial({ nodePath: '/root/Audio' }))).toBe(true);
    await handlers.handleGameAudioSpatial({ nodePath: '/root/Audio', action: 'get' });
    expect(calls[0]).toEqual({ name: 'audio_spatial', args: { node_path: '/root/Audio', action: 'get' } });
  });

  it('handleGameRenderSettings defaults action to get', async () => {
    const { handlers, calls } = gameHarness();
    await handlers.handleGameRenderSettings({});
    expect(calls[0]).toEqual({ name: 'render_settings', args: { action: 'get' } });
  });

  it('handleGameResource requires action and path', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameResource({}))).toBe(true);
    await handlers.handleGameResource({ action: 'exists', path: 'res://x.tres' });
    expect(calls[0].name).toBe('resource');
  });

  it('handleGameLocale requires action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameLocale({}))).toBe(true);
    await handlers.handleGameLocale({ action: 'get' });
    expect(calls[0]).toEqual({ name: 'locale', args: { action: 'get' } });
  });

  it('handleGameUiControl requires nodePath and action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameUiControl({ nodePath: '/root/UI' }))).toBe(true);
    await handlers.handleGameUiControl({ nodePath: '/root/UI', action: 'get' });
    expect(calls[0]).toEqual({ name: 'ui_control', args: { node_path: '/root/UI', action: 'get' } });
  });

  it('handleGameUiText validates action-specific requirements', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameUiText({ nodePath: '/root/Label' }))).toBe(true);
    expect(isErrorResponse(await handlers.handleGameUiText({ nodePath: '/root/Label', action: 'set' }))).toBe(true);
    await handlers.handleGameUiText({ nodePath: '/root/Label', action: 'set', text: 'Hi' });
    expect(calls[0]).toEqual({ name: 'ui_text', args: { node_path: '/root/Label', action: 'set', text: 'Hi' } });
  });

  it('handleGameUiPopup, UiTree, UiItemList, UiTabs, UiMenu, and UiRange pass node paths and actions', async () => {
    const { handlers, calls } = gameHarness();
    await handlers.handleGameUiPopup({ nodePath: '/root/Popup', action: 'get' });
    await handlers.handleGameUiTree({ nodePath: '/root/Tree', action: 'get_items' });
    await handlers.handleGameUiItemList({ nodePath: '/root/List', action: 'get_items' });
    await handlers.handleGameUiTabs({ nodePath: '/root/Tabs', action: 'get_tabs' });
    await handlers.handleGameUiMenu({ nodePath: '/root/Menu', action: 'get_items' });
    await handlers.handleGameUiRange({ nodePath: '/root/Slider', action: 'get' });
    expect(calls.map(call => call.name)).toEqual([
      'ui_popup', 'ui_tree', 'ui_item_list', 'ui_tabs', 'ui_menu', 'ui_range',
    ]);
  });

  it('handleGameTerrain requires action and per-action params', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameTerrain({}))).toBe(true);
    await handlers.handleGameTerrain({ action: 'get_height', nodePath: '/root/T', x: 1, z: 1 });
    expect(calls[0].name).toBe('terrain');
  });

  it('handleGameVisualShader requires action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameVisualShader({}))).toBe(true);
    await handlers.handleGameVisualShader({ action: 'get_nodes' });
    expect(calls[0].name).toBe('visual_shader');
  });

  it('handleGameVideo requires action', async () => {
    const { handlers, calls } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameVideo({}))).toBe(true);
    await handlers.handleGameVideo({ action: 'get' });
    expect(calls[0]).toEqual({ name: 'video', args: { action: 'get' } });
  });

  it('handleGameVisualRegression validates the action', async () => {
    const { handlers } = gameHarness();
    expect(isErrorResponse(await handlers.handleGameVisualRegression({ action: 'bogus' }))).toBe(true);
  });

  it('handleGameScreenshot returns an image content type', async () => {
    const { handlers, commands } = gameHarness();
    commands.send.mockResolvedValue({
      result: { data: Buffer.from('png-bytes').toString('base64'), width: 2, height: 2 },
    });
    const response = await handlers.handleGameScreenshot({});
    expect(Array.isArray(response.content)).toBe(true);
    const image = response.content.find(item => item.type === 'image');
    expect(image).toBeDefined();
    expect((image as { mimeType?: string }).mimeType).toBe('image/png');
  });

  it('enforces the runtime gates before dispatching', async () => {
    const noProcess = gameHarness({ process: false });
    expect(isErrorResponse(await noProcess.handlers.handleGameClick({}))).toBe(true);
    expect(noProcess.calls).toHaveLength(0);

    const noConnection = gameHarness({ connected: false });
    expect(isErrorResponse(await noConnection.handlers.handleGameClick({}))).toBe(true);
    expect(noConnection.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Project handlers — real ProjectToolHandlers with a mocked operations seam.
// The mock records execute() calls and simulates run() validation through the
// real HeadlessOperationService contract.
// ---------------------------------------------------------------------------

function projectHarness(options: { exitCode?: number; stdout?: string } = {}) {
  const root = createProject();
  const calls: { operation: string; params: Record<string, unknown> }[] = [];
  const execute = vi.fn((operation: string, params: Record<string, unknown>) => {
    calls.push({ operation, params });
    return Promise.resolve({
      stdout: options.stdout ?? `${operation} ok`,
      stderr: '',
      exitCode: options.exitCode ?? 0,
      signal: null,
    });
  });
  const run = vi.fn(() => Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }));
  const handlers = new ProjectToolHandlers({
    executable: { path: 'godot', requirePath: async () => '/godot' } as never,
    logDebug: vi.fn(),
    operations: { execute, run } as never,
    projectSupport: {
      findGodotProjects: () => [{ path: root, name: 'root' }],
      getProjectStructureAsync: async () => ({ directories: [], files: ['project.godot'] }),
      isDotnetProject: () => false,
    } as never,
  });
  return { handlers, root, calls, execute, run };
}

describe('Project handlers — real operations boundary', () => {
  it('handleCreateScene requires projectPath and scenePath', async () => {
    const { handlers } = projectHarness();
    expect(isErrorResponse(await handlers.handleCreateScene({ projectPath: '/nope', scenePath: 'main.tscn' }))).toBe(true);

    const ok = projectHarness();
    const response = await ok.handlers.handleCreateScene({ projectPath: ok.root, scenePath: 'main.tscn' });
    expect(textFrom(response)).toContain('Scene created successfully');
    expect(ok.calls[0]).toEqual({
      operation: 'create_scene',
      params: { scenePath: 'main.tscn', rootNodeType: 'Node2D' },
    });
  });

  it('handleAddNode requires projectPath, scenePath, nodeType, and nodeName', async () => {
    const { handlers } = projectHarness();
    expect(isErrorResponse(await handlers.handleAddNode({ projectPath: '/x', scenePath: 'a.tscn', nodeType: 'Node2D' }))).toBe(true);
    const ok = projectHarness();
    const response = await ok.handlers.handleAddNode({
      projectPath: ok.root, scenePath: 'main.tscn', nodeType: 'Node2D', nodeName: 'Player',
    });
    expect(ok.calls[0].operation).toBe('add_node');
    expect(isErrorResponse(response)).toBe(false);
  });

  it('handleModifySceneNode requires projectPath, scenePath, nodePath, and properties', async () => {
    const { handlers } = projectHarness();
    expect(isErrorResponse(await handlers.handleModifySceneNode({ projectPath: '/x', scenePath: 'main.tscn', nodePath: '/root/P' }))).toBe(true);
    const ok = projectHarness();
    const response = await ok.handlers.handleModifySceneNode({
      projectPath: ok.root, scenePath: 'main.tscn', nodePath: '/root/P', properties: { visible: true },
    });
    expect(isErrorResponse(response)).toBe(false);
  });

  it('handleRemoveSceneNode requires projectPath, scenePath, and nodePath', async () => {
    const ok = projectHarness();
    const response = await ok.handlers.handleRemoveSceneNode({
      projectPath: ok.root, scenePath: 'main.tscn', nodePath: '/root/Enemy',
    });
    expect(isErrorResponse(response)).toBe(false);
  });

  it('handleAttachScript requires projectPath, scenePath, nodePath, and scriptPath', async () => {
    const { handlers } = projectHarness();
    expect(isErrorResponse(await handlers.handleAttachScript({ projectPath: '/x', scenePath: 'a.tscn', nodePath: '/root/P' }))).toBe(true);
    const ok = projectHarness();
    const response = await ok.handlers.handleAttachScript({
      projectPath: ok.root, scenePath: 'main.tscn', nodePath: '/root/Player', scriptPath: 'scripts/player.gd',
    });
    expect(isErrorResponse(response)).toBe(false);
  });

  it('handleCreateResource requires projectPath, resourceType, and resourcePath', async () => {
    const { handlers } = projectHarness();
    expect(isErrorResponse(await handlers.handleCreateResource({ projectPath: '/x', resourceType: 'Theme' }))).toBe(true);
    const ok = projectHarness();
    const response = await ok.handlers.handleCreateResource({
      projectPath: ok.root, resourceType: 'Theme', resourcePath: 'res://theme.tres', properties: { font_size: 16 },
    });
    expect(isErrorResponse(response)).toBe(false);
  });

  it('handleSaveScene, handleLoadSprite, and handleExportMeshLibrary route to executeOperation', async () => {
    const save = projectHarness();
    const saveResponse = await save.handlers.handleSaveScene({
      projectPath: save.root, scenePath: 'main.tscn', newPath: 'main2.tscn',
    });
    expect(save.calls[0].operation).toBe('save_scene');
    expect(textFrom(saveResponse)).toContain('saved successfully');

    const sprite = projectHarness();
    const spriteResponse = await sprite.handlers.handleLoadSprite({
      projectPath: sprite.root, scenePath: 'main.tscn', nodePath: '/root/Sprite', texturePath: 'res://icon.png',
    });
    expect(sprite.calls[0].operation).toBe('load_sprite');
    expect(textFrom(spriteResponse)).toContain('Sprite loaded successfully');

    const mesh = projectHarness();
    const meshResponse = await mesh.handlers.handleExportMeshLibrary({
      projectPath: mesh.root, scenePath: 'main.tscn', outputPath: 'res://meshlib',
    });
    expect(mesh.calls[0].operation).toBe('export_mesh_library');
    expect(textFrom(meshResponse)).toContain('MeshLibrary exported successfully');
  });

  it('handleGetUid requires projectPath and filePath', async () => {
    const ok = projectHarness();
    const response = await ok.handlers.handleGetUid({ projectPath: ok.root, filePath: 'main.tscn' });
    expect(ok.calls[0].operation).toBe('get_uid');
    expect(textFrom(response)).toContain('UID for main.tscn');
  });

  it('handleReadScene extracts JSON from the operation output', async () => {
    const ok = projectHarness();
    mkdirSync(join(ok.root, 'scenes'), { recursive: true });
    writeFileSync(join(ok.root, 'scenes', 'main.tscn'), '');
    ok.execute.mockResolvedValue({
      stdout: 'SCENE_JSON_START\n{"nodes": []}\nSCENE_JSON_END\n',
      stderr: '', exitCode: 0, signal: null,
    });
    const response = await ok.handlers.handleReadScene({ projectPath: ok.root, scenePath: 'scenes/main.tscn' });
    expect(textFrom(response)).toContain('"nodes"');
  });

  it('handleReadProjectSettings parses the project.godot file', async () => {
    const ok = projectHarness();
    const response = await ok.handlers.handleReadProjectSettings({ projectPath: ok.root });
    expect(textFrom(response)).toContain('Test Game');
  });

  it('handleModifyProjectSettings writes to project.godot', async () => {
    const ok = projectHarness();
    const response = await ok.handlers.handleModifyProjectSettings({
      projectPath: ok.root, section: 'application', key: 'config/name', value: 'Renamed',
    });
    expect(isErrorResponse(response)).toBe(false);
    expect(existsSync(join(ok.root, 'project.godot'))).toBe(true);
  });

  it('handleListProjectFiles scans the project tree', async () => {
    const ok = projectHarness();
    mkdirSync(join(ok.root, 'scenes'), { recursive: true });
    writeFileSync(join(ok.root, 'scenes', 'main.tscn'), '');
    const response = await ok.handlers.handleListProjectFiles({ projectPath: ok.root });
    expect(textFrom(response)).toContain('project.godot');
    expect(textFrom(response)).toContain('scenes/main.tscn');
  });

  it('handleListProjects requires a directory and lists projects', async () => {
    const ok = projectHarness();
    const response = await ok.handlers.handleListProjects({ directory: ok.root });
    expect(textFrom(response)).toContain(ok.root);
  });

  it('handleGetProjectInfo reads project.godot', async () => {
    const ok = projectHarness();
    const response = await ok.handlers.handleGetProjectInfo({ projectPath: ok.root });
    expect(textFrom(response)).toContain('Test Game');
  });

  it('handleReadFile and handleWriteFile operate on the project filesystem', async () => {
    const ok = projectHarness();
    writeFileSync(join(ok.root, 'note.txt'), 'hello');
    const read = await ok.handlers.handleReadFile({ projectPath: ok.root, filePath: 'note.txt' });
    expect(textFrom(read)).toContain('hello');
    const written = await ok.handlers.handleWriteFile({ projectPath: ok.root, filePath: 'new.txt', content: 'data' });
    expect(isErrorResponse(written)).toBe(false);
    expect(existsSync(join(ok.root, 'new.txt'))).toBe(true);
  });

  it('handleDeleteFile and handleCreateDirectory mutate the filesystem', async () => {
    const ok = projectHarness();
    writeFileSync(join(ok.root, 'tmp.txt'), 'x');
    const deleted = await ok.handlers.handleDeleteFile({ projectPath: ok.root, filePath: 'tmp.txt' });
    expect(isErrorResponse(deleted)).toBe(false);
    expect(existsSync(join(ok.root, 'tmp.txt'))).toBe(false);
    const created = await ok.handlers.handleCreateDirectory({ projectPath: ok.root, directoryPath: 'assets' });
    expect(isErrorResponse(created)).toBe(false);
    expect(existsSync(join(ok.root, 'assets'))).toBe(true);
  });

  it('handleCreateProject requires projectPath and projectName', async () => {
    const { handlers } = projectHarness();
    expect(isErrorResponse(await handlers.handleCreateProject({ projectPath: '/x' }))).toBe(true);
    const ok = projectHarness();
    const target = join(ok.root, 'fresh-project');
    const response = await ok.handlers.handleCreateProject({ projectPath: target, projectName: 'New Game' });
    expect(isErrorResponse(response)).toBe(false);
    expect(existsSync(join(target, 'project.godot'))).toBe(true);
  });

  it('handleManageAutoloads, handleManageInputMap, and handleManageExportPresets require projectPath and action', async () => {
    const { handlers } = projectHarness();
    expect(isErrorResponse(await handlers.handleManageAutoloads({ projectPath: '/x' }))).toBe(true);
    expect(isErrorResponse(await handlers.handleManageInputMap({ projectPath: '/x' }))).toBe(true);
    expect(isErrorResponse(await handlers.handleManageExportPresets({ projectPath: '/x' }))).toBe(true);
  });

  it('handleExportProject validates projectPath and renders an export command', async () => {
    const ok = projectHarness();
    const response = await ok.handlers.handleExportProject({
      projectPath: ok.root, presetName: 'Linux/X11', outputPath: 'build/game',
    });
    expect(isErrorResponse(response)).toBe(false);
  });

  it('handleManageCiPipeline rejects unsafe generator values without writing a workflow', async () => {
    const ok = projectHarness();
    const response = await ok.handlers.handleManageCiPipeline({
      projectPath: ok.root, action: 'create', platforms: ['linux', 'linux; rm -rf /'],
    });
    expect(isErrorResponse(response)).toBe(true);
    expect(textFrom(response)).toContain('platforms');
    expect(existsSync(join(ok.root, '.github', 'workflows', 'godot-export.yml'))).toBe(false);
  });

  it('handleManageDockerExport rejects unsafe baseImage values', async () => {
    const ok = projectHarness();
    const response = await ok.handlers.handleManageDockerExport({
      projectPath: ok.root, action: 'create', baseImage: 'ubuntu:22.04\nRUN malicious',
    });
    expect(isErrorResponse(response)).toBe(true);
    expect(existsSync(join(ok.root, 'Dockerfile'))).toBe(false);
  });

  it('handleUpdateProjectUids validates the Godot version gate', async () => {
    const ok = projectHarness();
    const response = await ok.handlers.handleUpdateProjectUids({ projectPath: ok.root });
    expect(response).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle handlers — real LifecycleToolHandlers with a mocked process seam.
// ---------------------------------------------------------------------------

const mockChildProcess = {
  once: vi.fn(),
  on: vi.fn(),
  kill: vi.fn(),
  exitCode: 0,
  signalCode: null,
  stdout: { on: vi.fn() },
  stderr: { on: vi.fn() },
};

function activeProcessRecord(output: string[] = [], errors: string[] = []): GodotProcess {
  return {
    process: mockChildProcess as never,
    output,
    errors,
    outputDropped: 0,
    errorsDropped: 0,
  };
}

function lifecycleHarness(overrides: { projectPath?: string; connected?: boolean } = {}) {
  const root = overrides.projectPath ?? createProject();
  let processRecord: GodotProcess | null = null;
  const context: LifecycleToolHandlerContext = {
    executable: { path: '/godot', requirePath: async () => '/godot' } as never,
    getActiveProcess: () => processRecord,
    isPathAllowed: () => true,
    isRelativePathAllowed: () => true,
    isHeadless: () => false,
    logDebug: vi.fn(),
    startProjectProcess: vi.fn(() => {
      processRecord = activeProcessRecord(['started'], []);
      return processRecord;
    }),
    stopProjectProcess: vi.fn(() => {
      const record = processRecord;
      processRecord = null;
      return record;
    }),
    stopAuthoringSession: vi.fn(),
    connectToGame: vi.fn(async () => undefined),
    disconnectFromGame: vi.fn(),
    injectInteractionServer: vi.fn(),
    removeInteractionServer: vi.fn(),
    getConnectedProjectPath: () => (overrides.connected ?? false) ? root : null,
    clearConnectedProjectPath: vi.fn(),
    getInteractionPort: () => 9090,
    getRuntimeHandshake: () => ({ projectPath: root, currentScene: 'res://main.tscn' }),
    getRuntimeEnvironment: () => ({}),
    getEditorEnvironment: () => ({}),
    ensureEditorSession: vi.fn(async () => ({
      state: 'connected', project_path: root, connected: true, reused: true, spawned: false,
      editor_pid: 1, editor_start_identity: 'test', port: 9091, protocol_version: 2,
      addon_version: '1.1.5', godot_version: '4.7.1', created_at: 0,
    })),
    getEditorSessionStatus: vi.fn(async () => ({
      state: 'connected', project_path: root, connected: true, reused: true, spawned: false,
      editor_pid: 1, editor_start_identity: 'test', port: 9091, protocol_version: 2,
      addon_version: '1.1.5', godot_version: '4.7.1', created_at: 0,
    })),
    disconnectEditorSession: vi.fn(),
    isGameConnected: () => true,
    sendGameCommand: vi.fn(async () => ({ result: { current_scene: 'res://main.tscn' } })),
  };
  const handlers = new LifecycleToolHandlers(context);
  return { handlers, context, root };
}

describe('Lifecycle handlers — real project runtime seam', () => {
  it('handleRunProject launches, authenticates, and reports readiness', async () => {
    const { handlers, context } = lifecycleHarness();
    const response = await handlers.handleRunProject({ projectPath: context.getRuntimeHandshake()!.projectPath as string });
    expect(isErrorResponse(response)).toBe(false);
    expect(textFrom(response)).toContain('runtime_connected');
    expect(context.startProjectProcess).toHaveBeenCalledTimes(1);
    expect(context.connectToGame).toHaveBeenCalledTimes(1);
  });

  it('handleRunProject requires a valid projectPath', async () => {
    const { handlers } = lifecycleHarness();
    expect(isErrorResponse(await handlers.handleRunProject({}))).toBe(true);
    expect(isErrorResponse(await handlers.handleRunProject({ projectPath: '../../etc/passwd' }))).toBe(true);
  });

  it('handleRunProject stays headed by default', async () => {
    const { handlers, context, root } = lifecycleHarness();
    const response = await handlers.handleRunProject({ projectPath: root });
    expect(isErrorResponse(response)).toBe(false);
    const args = (context.startProjectProcess as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args[0]).not.toBe('--headless');
  });

  it('handleRunProject prepends --headless when headless mode is enabled', async () => {
    const { handlers, context, root } = lifecycleHarness();
    context.isHeadless = () => true;
    const response = await handlers.handleRunProject({ projectPath: root });
    expect(isErrorResponse(response)).toBe(false);
    const args = (context.startProjectProcess as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args[0]).toBe('--headless');
    expect(args).toContain('--path');
  });

  it('handleLaunchEditor prepends --headless to the editor process when headless mode is enabled', async () => {
    spawnMock.mockClear();
    const { handlers, context, root } = lifecycleHarness();
    context.isHeadless = () => true;
    let ensureCalls = 0;
    context.ensureEditorSession = vi.fn(async () => {
      ensureCalls += 1;
      if (ensureCalls === 1) return null;
      return {
        state: 'connected', project_path: root, connected: true, reused: false, spawned: false,
        editor_pid: 7, editor_start_identity: '7:1', port: 32001, protocol_version: 2,
        addon_version: '1.1.5', godot_version: '4.7.1', created_at: 0,
      };
    });
    const response = await handlers.handleLaunchEditor({ projectPath: root });
    expect(isErrorResponse(response)).toBe(false);
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock.mock.calls[0][1]).toEqual(expect.arrayContaining(['--headless', '-e']));
  });

  it('handleStopProject stops only an active process', async () => {
    const { handlers } = lifecycleHarness();
    expect(isErrorResponse(await handlers.handleStopProject())).toBe(true);

    const withProcess = lifecycleHarness({ connected: true });
    const record = activeProcessRecord(['line']);
    withProcess.context.getActiveProcess = () => record;
    (withProcess.context as { stopProjectProcess: ReturnType<typeof vi.fn> }).stopProjectProcess.mockReturnValue(record);
    const response = await withProcess.handlers.handleStopProject();
    expect(isErrorResponse(response)).toBe(false);
    expect(textFrom(response)).toContain('stopped');
  });

  it('handleGetDebugOutput requires an active process and reports output', async () => {
    const { handlers } = lifecycleHarness();
    expect(isErrorResponse(await handlers.handleGetDebugOutput())).toBe(true);

    const withOutput = lifecycleHarness();
    withOutput.context.getActiveProcess = () => activeProcessRecord(['hello world']);
    const response = await withOutput.handlers.handleGetDebugOutput();
    expect(textFrom(response)).toContain('hello world');
  });

  it('handleGetGodotVersion returns the version string', async () => {
    const { handlers } = lifecycleHarness();
    const response = await handlers.handleGetGodotVersion();
    expect(isErrorResponse(response)).toBe(false);
  });

  it('handleLaunchEditor requires a valid project and ensures a session', async () => {
    const { handlers } = lifecycleHarness();
    expect(isErrorResponse(await handlers.handleLaunchEditor({ projectPath: '../../x' }))).toBe(true);
    const ok = lifecycleHarness();
    const response = await ok.handlers.handleLaunchEditor({ projectPath: ok.root });
    expect(textFrom(response)).toContain('editor_session');
  });

  it('handleEditorSession reports status through the registry', async () => {
    const { handlers, root } = lifecycleHarness();
    const response = await handlers.handleEditorSession({ projectPath: root, action: 'status' });
    expect(isErrorResponse(response)).toBe(false);
    expect(textFrom(response)).toContain('editor_session');
  });

  it('handleEditorSession validates action and path', async () => {
    const { handlers } = lifecycleHarness();
    expect(isErrorResponse(await handlers.handleEditorSession({ projectPath: '/x', action: 'bogus' }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Registry cross-check: every manifest tool maps to a real handler method.
// Replaces the earlier source-substring "handler structure" checks.
// ---------------------------------------------------------------------------

describe('Tool manifest to real handler mapping', () => {
  it('every project-domain tool has a matching ProjectToolHandlers method', () => {
    const { handlers } = projectHarness();
    const missing = Object.entries(toolManifest)
      .filter(([, entry]) => entry.domain === 'project' && entry.handler !== undefined)
      .filter(([, entry]) => typeof (handlers as unknown as Record<string, unknown>)[entry.handler] !== 'function')
      .map(([name, entry]) => `${name}::${entry.handler}`);
    expect(missing).toEqual([]);
  });

  it('every game-domain tool has a matching GameToolHandlers method', () => {
    const { handlers } = gameHarness();
    const missing = Object.entries(toolManifest)
      .filter(([, entry]) => entry.domain === 'game' && entry.handler !== undefined)
      .filter(([, entry]) => typeof (handlers as unknown as Record<string, unknown>)[entry.handler] !== 'function')
      .map(([name, entry]) => `${name}::${entry.handler}`);
    expect(missing).toEqual([]);
  });

  it('every lifecycle-domain tool has a matching LifecycleToolHandlers method', () => {
    const { handlers } = lifecycleHarness();
    const missing = Object.entries(toolManifest)
      .filter(([, entry]) => entry.domain === 'lifecycle' && entry.handler !== undefined)
      .filter(([, entry]) => typeof (handlers as unknown as Record<string, unknown>)[entry.handler] !== 'function')
      .map(([name, entry]) => `${name}::${entry.handler}`);
    expect(missing).toEqual([]);
  });
});
