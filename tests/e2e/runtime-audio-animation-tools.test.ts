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

describe('runtime animation and audio layout tools through MCP', () => {
  it('creates typed animation tracks, controls playback, and completes a property tween', async () => {
    const game = await startedGame();
    expect(await evalResult(game, [
      'var main := get_tree().root.get_node("Main")',
      'var target := Node2D.new()',
      'target.name = "AnimatedTarget"',
      'main.add_child(target)',
      'var audio := AudioStreamPlayer.new()',
      'audio.name = "AnimationAudio"',
      'main.add_child(audio)',
      'var player := AnimationPlayer.new()',
      'player.name = "TrackPlayer"',
      'main.add_child(player)',
      'var wav := AudioStreamWAV.new()',
      'wav.format = AudioStreamWAV.FORMAT_8_BITS',
      'wav.mix_rate = 8000',
      'var data := PackedByteArray()',
      'data.resize(8000)',
      'data.fill(128)',
      'wav.data = data',
      'return ResourceSaver.save(wav, "res://animation-tone.tres")',
    ].join('\n'))).toBe(0);

    const created = await game.call('game_create_animation', {
      nodePath: '/root/Main/TrackPlayer', animationName: 'agent_demo', length: 0.2, loopMode: 0,
      tracks: [
        { type: 'value', path: 'AnimatedTarget:position', keys: [
          { time: 0, value: { x: 0, y: 0 }, type_hint: 'Vector2' },
          { time: 0.1, value: { x: 10, y: 4 }, type_hint: 'Vector2', transition: 0.5 },
        ] },
        { type: 'method', path: '.', keys: [{ time: 0.02, method: 'observe_value', args: [42, '-anim'] }] },
        { type: 'bezier', path: 'AnimatedTarget:rotation', keys: [{ time: 0, value: 0 }, { time: 0.1, value: 1 }] },
        { type: 'audio', path: 'AnimationAudio', keys: [{ time: 0, stream: 'res://animation-tone.tres' }] },
      ],
    });
    expect(created.isError, created.text).toBe(false);
    expect(payload(created.text)).toMatchObject({ animation_name: 'agent_demo', track_count: 4, length: 0.2 });
    expect(await evalResult(game, [
      'var animation := (get_node("/root/Main/TrackPlayer") as AnimationPlayer).get_animation("agent_demo")',
      'return {',
      '\t"tracks": animation.get_track_count(),',
      '\t"types": [animation.track_get_type(0) == Animation.TYPE_VALUE, animation.track_get_type(1) == Animation.TYPE_METHOD, animation.track_get_type(2) == Animation.TYPE_BEZIER, animation.track_get_type(3) == Animation.TYPE_AUDIO],',
      '\t"keys": [animation.track_get_key_count(0), animation.track_get_key_count(1), animation.track_get_key_count(2), animation.track_get_key_count(3)],',
      '\t"value": animation.track_get_key_value(0, 1),',
      '\t"audio_class": animation.audio_track_get_key_stream(3, 0).get_class(),',
      '}',
    ].join('\n'))).toEqual({ tracks: 4, types: [true, true, true, true], keys: [2, 1, 2, 1], value: { x: 10, y: 4 }, audio_class: 'AudioStreamWAV' });

    const duplicate = await game.call('game_create_animation', {
      nodePath: '/root/Main/TrackPlayer', animationName: 'agent_demo',
    });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.text).toMatch(/already exists/i);

    const listed = await game.call('game_play_animation', { nodePath: '/root/Main/TrackPlayer', action: 'get_list' });
    expect(listed.isError, listed.text).toBe(false);
    expect(payload(listed.text)).toMatchObject({ animations: ['agent_demo'] });
    expect((await game.call('game_play_animation', {
      nodePath: '/root/Main/TrackPlayer', action: 'play', animation: 'agent_demo',
    })).isError).toBe(false);
    await game.call('game_wait', { frames: 4 });
    expect((await game.call('game_get_nodes_in_group', { group: 'signal-value-42-anim' })).isError).toBe(false);
    expect(await evalResult(game, 'return get_node("/root/Main").is_in_group("signal-value-42-anim")')).toBe(true);
    expect((await game.call('game_play_animation', { nodePath: '/root/Main/TrackPlayer', action: 'pause' })).isError).toBe(false);
    expect(await evalResult(game, 'return (get_node("/root/Main/TrackPlayer") as AnimationPlayer).is_playing()')).toBe(false);
    expect((await game.call('game_play_animation', { nodePath: '/root/Main/TrackPlayer', action: 'stop' })).isError).toBe(false);

    const tween = await game.call('game_tween_property', {
      nodePath: '/root/Main/AnimatedTarget', property: 'position', finalValue: { x: 20, y: -5 },
      duration: 0.05, transType: 0, easeType: 0,
    });
    expect(tween.isError, tween.text).toBe(false);
    await game.call('game_wait', { frames: 10 });
    expect(await evalResult(game, 'return get_node("/root/Main/AnimatedTarget").position')).toEqual({ x: 20, y: -5 });
  });

  it('round-trips bone poses and drives SkeletonIK3D lifecycle and target state', async () => {
    const game = await startedGame();
    expect(await evalResult(game, [
      'var skeleton := Skeleton3D.new()',
      'skeleton.name = "Rig"',
      'get_tree().root.get_node("Main").add_child(skeleton)',
      'skeleton.add_bone("Root")',
      'skeleton.add_bone("Tip")',
      'skeleton.set_bone_parent(1, 0)',
      'skeleton.set_bone_rest(1, Transform3D(Basis.IDENTITY, Vector3(0, 1, 0)))',
      'var ik := SkeletonIK3D.new()',
      'ik.name = "IK"',
      'ik.root_bone = "Root"',
      'ik.tip_bone = "Tip"',
      'skeleton.add_child(ik)',
      'return [skeleton.get_bone_count(), ik.get_class()]',
    ].join('\n'))).toEqual([2, 'SkeletonIK3D']);

    const listed = await game.call('game_bone_pose', { nodePath: '/root/Main/Rig', action: 'list' });
    expect(listed.isError, listed.text).toBe(false);
    expect(payload(listed.text)).toMatchObject({ bone_count: 2, bones: [
      { index: 0, name: 'Root', parent: -1 }, { index: 1, name: 'Tip', parent: 0 },
    ] });
    expect((await game.call('game_bone_pose', {
      nodePath: '/root/Main/Rig', action: 'set', boneName: 'Tip',
      position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 2, y: 3, z: 4 },
    })).isError).toBe(false);
    const pose = await game.call('game_bone_pose', { nodePath: '/root/Main/Rig', action: 'get', boneIndex: 1 });
    expect(pose.isError, pose.text).toBe(false);
    expect(payload(pose.text)).toMatchObject({ bone_index: 1, bone_name: 'Tip', position: { x: 1, y: 2, z: 3 }, scale: { x: 2, y: 3, z: 4 } });

    expect((await game.call('game_skeleton_ik', {
      nodePath: '/root/Main/Rig/IK', action: 'set_target', target: { x: 3, y: 4, z: 5 },
    })).isError).toBe(false);
    expect(await evalResult(game, 'return (get_node("/root/Main/Rig/IK") as SkeletonIK3D).target.origin')).toEqual({ x: 3, y: 4, z: 5 });
    expect((await game.call('game_skeleton_ik', { nodePath: '/root/Main/Rig/IK', action: 'start' })).isError).toBe(false);
    expect(await evalResult(game, 'return (get_node("/root/Main/Rig/IK") as SkeletonIK3D).is_running()')).toBe(true);
    expect((await game.call('game_skeleton_ik', { nodePath: '/root/Main/Rig/IK', action: 'stop' })).isError).toBe(false);
    expect(await evalResult(game, 'return (get_node("/root/Main/Rig/IK") as SkeletonIK3D).is_running()')).toBe(false);
    const missingTarget = await game.call('game_skeleton_ik', { nodePath: '/root/Main/Rig/IK', action: 'set_target' });
    expect(missingTarget.isError).toBe(true);
    expect(missingTarget.text).toMatch(/target/i);
  });

  it('travels an AnimationTree state machine and updates a live transition parameter', async () => {
    const game = await startedGame();
    expect(await evalResult(game, [
      'var main := get_tree().root.get_node("Main")',
      'var player := AnimationPlayer.new()',
      'player.name = "TreePlayer"',
      'main.add_child(player)',
      'var library := AnimationLibrary.new()',
      'for name in ["Idle", "Run"]:',
      '\tvar animation := Animation.new()',
      '\tanimation.length = 1.0',
      '\tanimation.loop_mode = Animation.LOOP_LINEAR',
      '\tlibrary.add_animation(name, animation)',
      'player.add_animation_library("", library)',
      'var machine := AnimationNodeStateMachine.new()',
      'for name in ["Idle", "Run"]:',
      '\tvar node := AnimationNodeAnimation.new()',
      '\tnode.animation = name',
      '\tmachine.add_node(name, node)',
      'var transition := AnimationNodeStateMachineTransition.new()',
      'transition.advance_mode = AnimationNodeStateMachineTransition.ADVANCE_MODE_AUTO',
      'transition.advance_condition = "go"',
      'machine.add_transition("Idle", "Run", transition)',
      'var tree := AnimationTree.new()',
      'tree.name = "Tree"',
      'tree.anim_player = NodePath("../TreePlayer")',
      'tree.tree_root = machine',
      'main.add_child(tree)',
      'tree.active = true',
      'return tree.get_class()',
    ].join('\n'))).toBe('AnimationTree');
    await game.call('game_wait', { frames: 2 });

    expect((await game.call('game_animation_tree', {
      nodePath: '/root/Main/Tree', action: 'travel', stateName: 'Idle',
    })).isError).toBe(false);
    await game.call('game_wait', { frames: 2 });
    let state = await game.call('game_animation_tree', { nodePath: '/root/Main/Tree', action: 'get_state' });
    expect(payload(state.text)).toMatchObject({ current: 'Idle' });
    expect((await game.call('game_animation_tree', {
      nodePath: '/root/Main/Tree', action: 'set_param', paramName: 'conditions/go', paramValue: true,
    })).isError).toBe(false);
    await game.call('game_wait', { frames: 2 });
    state = await game.call('game_animation_tree', { nodePath: '/root/Main/Tree', action: 'get_state' });
    expect(payload(state.text)).toMatchObject({ current: 'Run' });
    expect(await evalResult(game, 'return get_node("/root/Main/Tree").get("parameters/conditions/go")')).toBe(true);
  });

  it('game_animation_control covers seek/queue/speed/info/stop against real Animation resources', async () => {
    const game = await startedGame();
    expect(await evalResult(game, [
      'var player := AnimationPlayer.new()',
      'player.name = "Animations"',
      'get_tree().root.get_node("Main").add_child(player)',
      'var library := AnimationLibrary.new()',
      'for animation_name in ["walk", "idle"]:',
      '\tvar animation := Animation.new()',
      '\tanimation.length = 10.0',
      '\tlibrary.add_animation(animation_name, animation)',
      'player.add_animation_library("", library)',
      'player.play("walk")',
      'return player.get_animation_list()',
    ].join('\n'))).toEqual(['idle', 'walk']);

    const seek = await game.call('game_animation_control', {
      nodePath: '/root/Main/Animations', action: 'seek', position: 2.5,
    });
    expect(seek.isError, seek.text).toBe(false);
    expect((await game.call('game_animation_control', {
      nodePath: '/root/Main/Animations', action: 'queue', animationName: 'idle',
    })).isError).toBe(false);
    expect((await game.call('game_animation_control', {
      nodePath: '/root/Main/Animations', action: 'set_speed', speed: 1.75,
    })).isError).toBe(false);

    const info = await game.call('game_animation_control', {
      nodePath: '/root/Main/Animations', action: 'get_info',
    });
    expect(info.isError, info.text).toBe(false);
    const state = payload(info.text) as {
      current: string; playing: boolean; animations: string[]; queued: string[];
      speed_scale: number; position: number;
    };
    expect(state).toMatchObject({
      current: 'walk', playing: true, animations: ['idle', 'walk'], queued: ['idle'], speed_scale: 1.75,
    });
    expect(state.position).toBeGreaterThanOrEqual(2.5);
    expect(state.position).toBeLessThan(2.75);
    const observed = await evalResult(game, [
      'var player := get_tree().root.get_node("Main/Animations") as AnimationPlayer',
      'return {"current": player.current_animation, "playing": player.is_playing(), "position": player.current_animation_position, "queue": player.get_queue(), "speed": player.speed_scale}',
    ].join('\n')) as { current: string; playing: boolean; position: number; queue: string[]; speed: number };
    expect(observed).toMatchObject({ current: 'walk', playing: true, queue: ['idle'], speed: 1.75 });
    expect(observed.position).toBeGreaterThanOrEqual(state.position);
    expect(observed.position).toBeLessThan(2.75);

    const missingAnimation = await game.call('game_animation_control', {
      nodePath: '/root/Main/Animations', action: 'queue', animationName: 'missing',
    });
    expect(missingAnimation.isError).toBe(true);
    expect(missingAnimation.text).toMatch(/Animation not found/i);
    expect((await game.call('game_animation_control', {
      nodePath: '/root/Main/Animations', action: 'stop',
    })).isError).toBe(false);
    expect(await evalResult(game, [
      'var player := get_tree().root.get_node("Main/Animations") as AnimationPlayer',
      'return {"playing": player.is_playing(), "queue": player.get_queue()}',
    ].join('\n'))).toEqual({ playing: false, queue: [] });

    const missingPosition = await game.call('game_animation_control', {
      nodePath: '/root/Main/Animations', action: 'seek',
    });
    expect(missingPosition.isError).toBe(true);
    expect(missingPosition.text).toMatch(/position is required/i);
  });

  it('game_audio_bus_layout covers add/list/move/send/remove with AudioServer cleanup', async () => {
    const game = await startedGame();
    const baseline = await evalResult(game, 'return AudioServer.bus_count') as number;

    expect((await game.call('game_audio_bus_layout', {
      action: 'add', busName: 'E2E Music',
    })).isError).toBe(false);
    expect((await game.call('game_audio_bus_layout', {
      action: 'add', busName: 'E2E FX',
    })).isError).toBe(false);
    let listed = await game.call('game_audio_bus_layout', { action: 'list' });
    let buses = (payload(listed.text) as { buses: { name: string; index: number; send: string }[] }).buses;
    expect(buses.find(bus => bus.name === 'E2E Music')).toMatchObject({ index: baseline });
    expect(buses.find(bus => bus.name === 'E2E FX')).toMatchObject({ index: baseline + 1 });

    const duplicate = await game.call('game_audio_bus_layout', {
      action: 'add', busName: 'E2E Music',
    });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.text).toMatch(/already exists/i);
    expect((await game.call('game_audio_bus_layout', {
      action: 'move', busName: 'E2E FX', index: baseline,
    })).isError).toBe(false);
    expect((await game.call('game_audio_bus_layout', {
      action: 'set_send', busName: 'E2E Music', sendTo: 'E2E FX',
    })).isError).toBe(false);

    listed = await game.call('game_audio_bus_layout', { action: 'list' });
    buses = (payload(listed.text) as { buses: { name: string; index: number; send: string }[] }).buses;
    expect(buses.find(bus => bus.name === 'E2E FX')).toMatchObject({ index: baseline, send: '' });
    expect(buses.find(bus => bus.name === 'E2E Music')).toMatchObject({ index: baseline + 1, send: 'E2E FX' });
    expect(await evalResult(game, [
      'var fx := AudioServer.get_bus_index("E2E FX")',
      'var music := AudioServer.get_bus_index("E2E Music")',
      'return {"fx": fx, "music": music, "send": AudioServer.get_bus_send(music), "count": AudioServer.bus_count}',
    ].join('\n'))).toEqual({ fx: baseline, music: baseline + 1, send: 'E2E FX', count: baseline + 2 });

    const selfSend = await game.call('game_audio_bus_layout', {
      action: 'set_send', busName: 'E2E Music', sendTo: 'E2E Music',
    });
    expect(selfSend.isError).toBe(true);
    expect(selfSend.text).toMatch(/cannot send to itself/i);
    expect((await game.call('game_audio_bus_layout', {
      action: 'remove', busName: 'E2E Music',
    })).isError).toBe(false);
    expect((await game.call('game_audio_bus_layout', {
      action: 'remove', busName: 'E2E FX',
    })).isError).toBe(false);
    expect(await evalResult(game, [
      'return {"count": AudioServer.bus_count, "music": AudioServer.get_bus_index("E2E Music"), "fx": AudioServer.get_bus_index("E2E FX")}',
    ].join('\n'))).toEqual({ count: baseline, music: -1, fx: -1 });

    const master = await game.call('game_audio_bus_layout', { action: 'remove', busName: 'Master' });
    expect(master.isError).toBe(true);
    expect(master.text).toMatch(/Cannot remove bus/i);
  });

  it('discovers every player type and controls audio playback, bus state, and 3D attenuation', async () => {
    const game = await startedGame();
    expect(await evalResult(game, [
      'AudioServer.add_bus()',
      'var bus := AudioServer.bus_count - 1',
      'AudioServer.set_bus_name(bus, "E2E Audio")',
      'var wav := AudioStreamWAV.new()',
      'wav.format = AudioStreamWAV.FORMAT_8_BITS',
      'wav.mix_rate = 8000',
      'var data := PackedByteArray()',
      'data.resize(16000)',
      'data.fill(128)',
      'wav.data = data',
      'wav.loop_mode = AudioStreamWAV.LOOP_FORWARD',
      'wav.loop_begin = 0',
      'wav.loop_end = 16000',
      'var main := get_tree().root.get_node("Main")',
      'for spec in [["PlainAudio", AudioStreamPlayer.new()], ["Audio2D", AudioStreamPlayer2D.new()], ["Audio3D", AudioStreamPlayer3D.new()]]:',
      '\tvar player: Node = spec[1]',
      '\tplayer.name = spec[0]',
      '\tplayer.set("stream", wav)',
      '\tplayer.set("bus", "E2E Audio")',
      '\tmain.add_child(player)',
      'return AudioServer.get_bus_index("E2E Audio")',
    ].join('\n'))).toBeGreaterThan(0);

    let audio = await game.call('game_get_audio');
    expect(audio.isError, audio.text).toBe(false);
    const players = (payload(audio.text) as { players: { path: string; type: string; playing: boolean; bus: string }[] }).players;
    expect(players).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/root/Main/PlainAudio', type: 'AudioStreamPlayer', bus: 'E2E Audio' }),
      expect.objectContaining({ path: '/root/Main/Audio2D', type: 'AudioStreamPlayer2D', bus: 'E2E Audio' }),
      expect.objectContaining({ path: '/root/Main/Audio3D', type: 'AudioStreamPlayer3D', bus: 'E2E Audio' }),
    ]));

    const bus = await game.call('game_audio_bus', { busName: 'E2E Audio', volume: 0.5, mute: true, solo: true });
    expect(bus.isError, bus.text).toBe(false);
    expect(payload(bus.text)).toMatchObject({ bus_name: 'E2E Audio', mute: true, solo: true });
    expect((payload(bus.text) as { volume_db: number }).volume_db).toBeCloseTo(-6.0206, 3);

    expect((await game.call('game_audio_play', {
      nodePath: '/root/Main/PlainAudio', action: 'play', volume: 0.25, pitch: 1.5, bus: 'E2E Audio', fromPosition: 0.1,
    })).isError).toBe(false);
    const playbackState = await evalResult(game, [
      'var player := get_node("/root/Main/PlainAudio") as AudioStreamPlayer',
      'return {"playing": player.playing, "paused": player.stream_paused, "pitch": player.pitch_scale, "bus": player.bus, "volume": player.volume_db}',
    ].join('\n')) as { playing: boolean; paused: boolean; pitch: number; bus: string; volume: number };
    expect(playbackState).toMatchObject({ playing: true, paused: false, pitch: 1.5, bus: 'E2E Audio' });
    expect(playbackState.volume).toBeCloseTo(-12.0412, 3);
    expect((await game.call('game_audio_play', { nodePath: '/root/Main/PlainAudio', action: 'pause' })).isError).toBe(false);
    expect(await evalResult(game, 'return (get_node("/root/Main/PlainAudio") as AudioStreamPlayer).stream_paused')).toBe(true);
    expect((await game.call('game_audio_play', { nodePath: '/root/Main/PlainAudio', action: 'resume' })).isError).toBe(false);
    expect(await evalResult(game, 'return (get_node("/root/Main/PlainAudio") as AudioStreamPlayer).stream_paused')).toBe(false);
    audio = await game.call('game_get_audio');
    expect((payload(audio.text) as { players: { path: string; playing: boolean }[] }).players)
      .toContainEqual(expect.objectContaining({ path: '/root/Main/PlainAudio', playing: true }));
    expect((await game.call('game_audio_play', { nodePath: '/root/Main/PlainAudio', action: 'stop' })).isError).toBe(false);
    expect(await evalResult(game, 'return (get_node("/root/Main/PlainAudio") as AudioStreamPlayer).playing')).toBe(false);

    expect((await game.call('game_audio_spatial', {
      nodePath: '/root/Main/Audio3D', action: 'configure', maxDistance: 75, unitSize: 2.5, maxDb: 6, attenuationModel: 'logarithmic',
    })).isError).toBe(false);
    const spatial = await game.call('game_audio_spatial', { nodePath: '/root/Main/Audio3D', action: 'get_info' });
    expect(spatial.isError, spatial.text).toBe(false);
    expect(payload(spatial.text)).toMatchObject({ max_distance: 75, unit_size: 2.5, max_db: 6, attenuation_model: 'logarithmic' });
    await expect(game.call('game_audio_spatial', {
      nodePath: '/root/Main/Audio3D', action: 'configure', attenuationModel: 'linear',
    })).rejects.toThrow(/attenuationModel.*inverse.*logarithmic/i);
    expect(await evalResult(game, [
      'var bus := AudioServer.get_bus_index("E2E Audio")',
      'AudioServer.remove_bus(bus)',
      'return AudioServer.get_bus_index("E2E Audio")',
    ].join('\n'))).toBe(-1);
  });

  it('adds every supported audio effect and independently verifies configure/remove state', async () => {
    const game = await startedGame();
    expect(await evalResult(game, [
      'AudioServer.add_bus()',
      'AudioServer.set_bus_name(AudioServer.bus_count - 1, "E2E Effects")',
      'return AudioServer.get_bus_index("E2E Effects")',
    ].join('\n'))).toBeGreaterThan(0);
    for (const effectType of ['reverb', 'delay', 'chorus', 'eq', 'compressor', 'limiter']) {
      const added = await game.call('game_audio_effect', { busName: 'E2E Effects', action: 'add', effectType });
      expect(added.isError, `${effectType}: ${added.text}`).toBe(false);
    }
    let effects = await game.call('game_audio_effect', { busName: 'E2E Effects', action: 'list' });
    expect((payload(effects.text) as { effects: { type: string }[] }).effects.map(effect => effect.type)).toEqual([
      'AudioEffectReverb', 'AudioEffectDelay', 'AudioEffectChorus', 'AudioEffectEQ6', 'AudioEffectCompressor', 'AudioEffectLimiter',
    ]);
    const configured = await game.call('game_audio_effect', {
      busName: 'E2E Effects', action: 'configure', index: 0, properties: { room_size: 0.8, damping: 0.25 }, enabled: false,
    });
    expect(configured.isError, configured.text).toBe(false);
    const effectState = await evalResult(game, [
      'var bus := AudioServer.get_bus_index("E2E Effects")',
      'var effect := AudioServer.get_bus_effect(bus, 0) as AudioEffectReverb',
      'return {"room": effect.room_size, "damping": effect.damping, "enabled": AudioServer.is_bus_effect_enabled(bus, 0)}',
    ].join('\n')) as { room: number; damping: number; enabled: boolean };
    expect(effectState).toMatchObject({ damping: 0.25, enabled: false });
    expect(effectState.room).toBeCloseTo(0.8, 5);
    for (let index = 5; index >= 0; index -= 1) {
      expect((await game.call('game_audio_effect', { busName: 'E2E Effects', action: 'remove', index })).isError).toBe(false);
    }
    effects = await game.call('game_audio_effect', { busName: 'E2E Effects', action: 'list' });
    expect(payload(effects.text)).toMatchObject({ effects: [] });
    const invalid = await game.call('game_audio_effect', { busName: 'E2E Effects', action: 'remove', index: 0 });
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toMatch(/out of range/i);
    expect(await evalResult(game, [
      'AudioServer.remove_bus(AudioServer.get_bus_index("E2E Effects"))',
      'return AudioServer.get_bus_index("E2E Effects")',
    ].join('\n'))).toBe(-1);
  });
});
