// @test-kind: e2e
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTempProject, importProjectResources, startServer, writeOgvFixture, type E2EServer,
} from './helpers/harness.js';

/**
 * Full-path E2E coverage for the camera, shader, particle, viewport, render,
 * sky, GI, and video tools. The fixture scene has no camera, so each test spawns
 * the camera it needs through the public tools and then confirms the result by
 * reading engine state back, never by trusting the mutating response.
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

async function startedGame(project?: { root: string; projectPath: string }): Promise<E2EServer> {
  // These tools are unprivileged; game_eval is the privileged *observer*.
  server = await startServer({ allowPrivileged: true, project });
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

/** Spawn a Camera3D and make it the viewport's active camera. */
async function spawnCamera3D(game: E2EServer): Promise<void> {
  const spawned = await game.call('game_spawn_node', {
    type: 'Camera3D', name: 'Eye', parentPath: '/root/Main', properties: { current: true },
  });
  expect(spawned.isError, spawned.text).toBe(false);
  expect(await engineEval(game, 'return get_viewport().get_camera_3d() != null')).toBe(true);
}

describe('camera tools through MCP', () => {
  it('game_get_camera reports no camera, then the active Camera2D after one is added', async () => {
    const game = await startedGame();

    const none = await game.call('game_get_camera');
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/no active camera/i);

    const spawned = await game.call('game_spawn_node', {
      type: 'Camera2D', name: 'Eye2D', parentPath: '/root/Main', properties: { position: { x: 5, y: 6 } },
    });
    expect(spawned.isError, spawned.text).toBe(false);

    const found = await game.call('game_get_camera');
    expect(found.isError, found.text).toBe(false);
    const camera = payload(found.text) as { camera_2d: { position: { x: number; y: number }; path: string } };
    expect(camera.camera_2d.path).toBe('/root/Main/Eye2D');
    expect(camera.camera_2d.position).toEqual({ x: 5, y: 6 });
  });

  it('game_set_camera moves the active Camera2D and its zoom', async () => {
    const game = await startedGame();
    await game.call('game_spawn_node', { type: 'Camera2D', name: 'Eye2D', parentPath: '/root/Main' });

    const set = await game.call('game_set_camera', {
      position: { x: 40, y: 50 }, zoom: { x: 2, y: 2 }, rotation: { z: 90 },
    });
    expect(set.isError, set.text).toBe(false);
    expect(payload(set.text)).toMatchObject({ camera: '2d' });

    // Independent observation: the engine's Camera2D holds the new transform.
    const observed = await engineEval(game, [
      'var cam = get_viewport().get_camera_2d()',
      'return {',
      '\t"x": cam.global_position.x, "y": cam.global_position.y,',
      '\t"zoom": cam.zoom.x, "rotation": snappedf(rad_to_deg(cam.global_rotation), 0.01),',
      '}',
    ].join('\n')) as { x: number; y: number; zoom: number; rotation: number };
    expect(observed).toEqual({ x: 40, y: 50, zoom: 2, rotation: 90 });

    // Unspecified fields are preserved rather than reset.
    await game.call('game_set_camera', { position: { x: 1, y: 2 } });
    expect(await engineEval(game, 'return get_viewport().get_camera_2d().zoom.x')).toBe(2);
  });

  it('game_set_camera drives a Camera3D position, rotation, and fov', async () => {
    const game = await startedGame();
    await spawnCamera3D(game);

    const set = await game.call('game_set_camera', {
      position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 45, z: 0 }, fov: 50,
    });
    expect(set.isError, set.text).toBe(false);
    expect(payload(set.text)).toMatchObject({ camera: '3d' });

    const observed = await engineEval(game, [
      'var cam = get_viewport().get_camera_3d()',
      'return {',
      '\t"pos": [cam.global_position.x, cam.global_position.y, cam.global_position.z],',
      '\t"yaw": snappedf(rad_to_deg(cam.global_rotation.y), 0.01),',
      '\t"fov": cam.fov,',
      '}',
    ].join('\n')) as { pos: number[]; yaw: number; fov: number };
    expect(observed.pos).toEqual([1, 2, 3]);
    expect(observed.yaw).toBe(45);
    expect(observed.fov).toBe(50);

    const readBack = await game.call('game_get_camera');
    expect(payload(readBack.text)).toMatchObject({ camera_3d: { fov: 50, path: '/root/Main/Eye' } });
  });

  it('game_camera_attributes get/set round-trips depth of field and exposure', async () => {
    const game = await startedGame();

    const noCamera = await game.call('game_camera_attributes', { action: 'get' });
    expect(noCamera.isError).toBe(true);
    expect(noCamera.text).toMatch(/no camera3d/i);

    await spawnCamera3D(game);

    const bare = await game.call('game_camera_attributes', { action: 'get' });
    expect(bare.isError, bare.text).toBe(false);
    expect(payload(bare.text)).toMatchObject({ has_attributes: false });

    const set = await game.call('game_camera_attributes', {
      action: 'set', dofBlurFar: 25, dofBlurNear: 3, dofBlurAmount: 0.25,
      exposureMultiplier: 2, autoExposure: true, autoExposureScale: 0.6,
    });
    expect(set.isError, set.text).toBe(false);

    // Independent observation: the engine's CameraAttributes resource holds every
    // value, including the exposure fields the runtime used to silently drop.
    const observed = await engineEval(game, [
      'var attributes = get_viewport().get_camera_3d().attributes',
      'return {',
      '\t"far": attributes.dof_blur_far_distance,',
      '\t"far_enabled": attributes.dof_blur_far_enabled,',
      '\t"near": attributes.dof_blur_near_distance,',
      '\t"amount": snappedf(attributes.dof_blur_amount, 0.001),',
      '\t"exposure": attributes.exposure_multiplier,',
      '\t"auto": attributes.auto_exposure_enabled,',
      '\t"auto_scale": snappedf(attributes.auto_exposure_scale, 0.001),',
      '}',
    ].join('\n')) as Record<string, number | boolean>;
    expect(observed).toEqual({
      far: 25, far_enabled: true, near: 3, amount: 0.25,
      exposure: 2, auto: true, auto_scale: 0.6,
    });

    // `get` must report the values, not merely that attributes exist.
    const readBack = await game.call('game_camera_attributes', { action: 'get' });
    expect(payload(readBack.text)).toMatchObject({
      has_attributes: true, dof_blur_far: 25, dof_blur_near: 3,
      exposure_multiplier: 2, auto_exposure: true,
    });
  });
});

describe('shader, particle, and viewport tools through MCP', () => {
  it('game_set_shader_param writes a uniform on a real ShaderMaterial', async () => {
    const game = await startedGame();

    // Author the shader through the public tool, then attach it to a sprite.
    const shader = await game.call('manage_shader', {
      projectPath: game.projectPath,
      shaderPath: 'tint.gdshader',
      action: 'create',
      source: 'shader_type canvas_item;\n\nuniform vec4 tint : source_color = vec4(1.0);\nuniform float strength = 0.0;\n\nvoid fragment() {\n\tCOLOR = tint * strength;\n}\n',
    });
    expect(shader.isError, shader.text).toBe(false);

    await game.call('game_spawn_node', { type: 'Sprite2D', name: 'Tinted', parentPath: '/root/Main' });
    await engineEval(game, [
      'var material := ShaderMaterial.new()',
      'material.shader = load("res://tint.gdshader")',
      'get_node("/root/Main/Tinted").material = material',
      'return true',
    ].join('\n'));

    const set = await game.call('game_set_shader_param', {
      nodePath: '/root/Main/Tinted', paramName: 'strength', value: 0.75,
    });
    expect(set.isError, set.text).toBe(false);

    // Independent observation: the material reports the uniform value.
    expect(await engineEval(game, 'return snappedf(get_node("/root/Main/Tinted").material.get_shader_parameter("strength"), 0.001)'))
      .toBe(0.75);

    // A structured value with an explicit type hint.
    const colored = await game.call('game_set_shader_param', {
      nodePath: '/root/Main/Tinted', paramName: 'tint',
      value: { r: 1, g: 0, b: 0, a: 1 }, typeHint: 'Color',
    });
    expect(colored.isError, colored.text).toBe(false);
    expect(await engineEval(game, 'var c = get_node("/root/Main/Tinted").material.get_shader_parameter("tint")\nreturn [c.r, c.g, c.b, c.a]'))
      .toEqual([1, 0, 0, 1]);

    const noMaterial = await game.call('game_set_shader_param', {
      nodePath: '/root/Main/Anchor', paramName: 'strength', value: 1,
    });
    expect(noMaterial.isError).toBe(true);
    expect(noMaterial.text).toMatch(/no shadermaterial/i);
  });

  it('game_set_particles configures a GPUParticles2D and its process material', async () => {
    const game = await startedGame();
    await game.call('game_spawn_node', { type: 'GPUParticles2D', name: 'Sparks', parentPath: '/root/Main' });

    const configured = await game.call('game_set_particles', {
      nodePath: '/root/Main/Sparks',
      emitting: true, amount: 32, lifetime: 2.5, oneShot: true,
      speedScale: 1.5, explosiveness: 0.4, randomness: 0.2,
      processMaterial: {
        direction: { x: 1, y: 0, z: 0 }, spread: 15,
        gravity: { x: 0, y: -3, z: 0 },
        initialVelocityMin: 4, initialVelocityMax: 8,
        color: { r: 1, g: 0.5, b: 0, a: 1 },
        scaleMin: 0.5, scaleMax: 2,
      },
    });
    expect(configured.isError, configured.text).toBe(false);
    expect(payload(configured.text)).toMatchObject({
      emitting: true, amount: 32, lifetime: 2.5, one_shot: true, speed_scale: 1.5,
    });

    // Independent observation: the node and its ParticleProcessMaterial hold the
    // requested configuration.
    const observed = await engineEval(game, [
      'var particles = get_node("/root/Main/Sparks")',
      'var material: ParticleProcessMaterial = particles.process_material',
      'return {',
      '\t"amount": particles.amount,',
      '\t"lifetime": particles.lifetime,',
      '\t"explosiveness": snappedf(particles.explosiveness, 0.001),',
      '\t"randomness": snappedf(particles.randomness, 0.001),',
      '\t"spread": material.spread,',
      '\t"direction": [material.direction.x, material.direction.y, material.direction.z],',
      '\t"gravity_y": material.gravity.y,',
      '\t"velocity": [material.initial_velocity_min, material.initial_velocity_max],',
      '\t"color": [material.color.r, snappedf(material.color.g, 0.01), material.color.b],',
      '\t"scale": [material.scale_min, material.scale_max],',
      '}',
    ].join('\n')) as Record<string, unknown>;
    expect(observed).toEqual({
      amount: 32, lifetime: 2.5, explosiveness: 0.4, randomness: 0.2,
      spread: 15, direction: [1, 0, 0], gravity_y: -3,
      velocity: [4, 8], color: [1, 0.5, 0], scale: [0.5, 2],
    });

    const wrongNode = await game.call('game_set_particles', { nodePath: '/root/Main/Anchor', emitting: true });
    expect(wrongNode.isError).toBe(true);
    expect(wrongNode.text).toMatch(/not a gpuparticles node/i);

    const missing = await game.call('game_set_particles', { nodePath: '/root/Main/Ghost' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/node not found/i);
  });

  it('game_viewport create/configure/get manages a real SubViewport', async () => {
    const game = await startedGame();

    const created = await game.call('game_viewport', {
      action: 'create', parentPath: '/root/Main', name: 'Mirror',
      width: 320, height: 180, transparentBg: true, msaa: 2,
    });
    expect(created.isError, created.text).toBe(false);
    const viewport = payload(created.text) as { viewport_path: string; container_path: string };
    expect(viewport.viewport_path).toContain('Mirror');

    // Independent observation: a real SubViewport inside a SubViewportContainer.
    const observed = await engineEval(game, [
      `var sub = get_node("${viewport.viewport_path}")`,
      'return {',
      '\t"class": sub.get_class(),',
      '\t"parent": sub.get_parent().get_class(),',
      '\t"width": sub.size.x, "height": sub.size.y,',
      '\t"transparent": sub.transparent_bg, "msaa": sub.msaa_3d,',
      '}',
    ].join('\n')) as Record<string, unknown>;
    expect(observed).toEqual({
      class: 'SubViewport', parent: 'SubViewportContainer',
      width: 320, height: 180, transparent: true, msaa: 2,
    });

    const got = await game.call('game_viewport', { action: 'get', nodePath: viewport.viewport_path });
    expect(got.isError, got.text).toBe(false);
    expect(payload(got.text)).toMatchObject({ size: { x: 320, y: 180 }, transparent_bg: true, msaa_3d: 2 });

    const configured = await game.call('game_viewport', {
      action: 'configure', nodePath: viewport.viewport_path, width: 64, height: 64, transparentBg: false,
    });
    expect(configured.isError, configured.text).toBe(false);
    expect(await engineEval(game, `var s = get_node("${viewport.viewport_path}")\nreturn [s.size.x, s.size.y, s.transparent_bg]`))
      .toEqual([64, 64, false]);

    const missing = await game.call('game_viewport', { action: 'get', nodePath: '/root/Main/Anchor' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/subviewport not found/i);

    const noPath = await game.call('game_viewport', { action: 'configure' });
    expect(noPath.isError).toBe(true);
    expect(noPath.text).toMatch(/node_path is required/i);
  });

  it('game_render_settings get/set drives the real viewport', async () => {
    const game = await startedGame();

    const initial = await game.call('game_render_settings', { action: 'get' });
    expect(initial.isError, initial.text).toBe(false);
    const before = payload(initial.text) as Record<string, number | boolean>;
    expect(before).toHaveProperty('msaa_2d');
    expect(before).toHaveProperty('scaling_3d_scale');

    const set = await game.call('game_render_settings', {
      action: 'set', msaa2d: 2, msaa3d: 1, fxaa: true, taa: true, scalingMode: 1, scalingScale: 0.75,
    });
    expect(set.isError, set.text).toBe(false);

    // Independent observation: the engine viewport reports every applied setting.
    // SCREEN_SPACE_AA_FXAA is 1.
    const observed = await engineEval(game, [
      'var vp = get_viewport()',
      'return {',
      '\t"msaa_2d": vp.msaa_2d, "msaa_3d": vp.msaa_3d,',
      '\t"aa": vp.screen_space_aa, "taa": vp.use_taa,',
      '\t"mode": vp.scaling_3d_mode, "scale": snappedf(vp.scaling_3d_scale, 0.001),',
      '}',
    ].join('\n')) as Record<string, unknown>;
    expect(observed).toEqual({ msaa_2d: 2, msaa_3d: 1, aa: 1, taa: true, mode: 1, scale: 0.75 });

    const readBack = await game.call('game_render_settings', { action: 'get' });
    expect(payload(readBack.text)).toMatchObject({ msaa_2d: 2, msaa_3d: 1, use_taa: true, scaling_3d_scale: 0.75 });
  });
});

describe('sky, global illumination, and video tools through MCP', () => {
  it('game_sky creates a procedural sky on the world environment', async () => {
    const game = await startedGame();

    const created = await game.call('game_sky', {
      action: 'create', skyType: 'procedural',
      topColor: { r: 0.1, g: 0.2, b: 0.9 },
      bottomColor: { r: 0.5, g: 0.5, b: 0.5 },
      groundColor: { r: 0.2, g: 0.1, b: 0.05 },
      sunEnergy: 0.3,
    });
    expect(created.isError, created.text).toBe(false);
    expect(payload(created.text)).toMatchObject({ action: 'create', sky_type: 'procedural' });

    // Independent observation: a WorldEnvironment now exists whose Environment
    // uses a Sky backed by a ProceduralSkyMaterial with the requested colors.
    const observed = await engineEval(game, [
      'var found: WorldEnvironment = null',
      'for child in get_tree().root.get_children():',
      '\tif child is WorldEnvironment:',
      '\t\tfound = child',
      'var environment := found.environment',
      'var material: ProceduralSkyMaterial = environment.sky.sky_material',
      'return {',
      '\t"background": environment.background_mode,',
      '\t"top": [snappedf(material.sky_top_color.r, 0.01), snappedf(material.sky_top_color.b, 0.01)],',
      '\t"ground": snappedf(material.ground_bottom_color.r, 0.01),',
      '\t"sun_curve": snappedf(material.sun_curve, 0.01),',
      '}',
    ].join('\n')) as Record<string, unknown>;
    // Environment.BG_SKY is 2.
    expect(observed).toEqual({ background: 2, top: [0.1, 0.9], ground: 0.2, sun_curve: 0.3 });
  });

  it('game_gi creates each supported global illumination node', async () => {
    const game = await startedGame();

    const voxel = await game.call('game_gi', {
      parentPath: '/root/Main', giType: 'voxel_gi', name: 'Voxels', size: { x: 4, y: 5, z: 6 },
    });
    expect(voxel.isError, voxel.text).toBe(false);
    expect(payload(voxel.text)).toMatchObject({ path: '/root/Main/Voxels', gi_type: 'voxel_gi' });
    expect(await engineEval(game, 'var v = get_node("/root/Main/Voxels")\nreturn [v.get_class(), v.size.x, v.size.y, v.size.z]'))
      .toEqual(['VoxelGI', 4, 5, 6]);

    const lightmap = await game.call('game_gi', {
      parentPath: '/root/Main', giType: 'lightmap_gi', name: 'Lightmap',
    });
    expect(lightmap.isError, lightmap.text).toBe(false);
    expect(await engineEval(game, 'return get_node("/root/Main/Lightmap").get_class()')).toBe('LightmapGI');

    // reflection_probe was advertised by the schema but had no branch in the
    // runtime, so it always failed; it must now create a real ReflectionProbe.
    const probe = await game.call('game_gi', {
      parentPath: '/root/Main', giType: 'reflection_probe', name: 'Probe', size: { x: 8, y: 8, z: 8 },
    });
    expect(probe.isError, probe.text).toBe(false);
    expect(payload(probe.text)).toMatchObject({ path: '/root/Main/Probe', gi_type: 'reflection_probe' });
    expect(await engineEval(game, 'var p = get_node("/root/Main/Probe")\nreturn [p.get_class(), p.size.x]'))
      .toEqual(['ReflectionProbe', 8]);

    const badParent = await game.call('game_gi', { parentPath: '/root/Nowhere', giType: 'voxel_gi' });
    expect(badParent.isError).toBe(true);

    const badType = await game.call('game_gi', { parentPath: '/root/Main', giType: 'holograms' });
    expect(badType.isError).toBe(true);
    expect(badType.text).toMatch(/gi_type must be one of/i);
  });

  it('game_video drives a real Theora stream through every action', async () => {
    const project = createTempProject();
    writeOgvFixture(project.projectPath, 'clip.ogv');
    await importProjectResources(project.projectPath);
    const game = await startedGame(project);

    const created = await game.call('game_video', {
      action: 'create', parentPath: '/root/Main', videoPath: 'res://clip.ogv', name: 'Movie', volume: 0.5,
    });
    expect(created.isError, created.text).toBe(false);
    expect(payload(created.text)).toMatchObject({ action: 'create', path: '/root/Main/Movie' });

    // Independent observation: a VideoStreamPlayer holding a real Theora stream.
    expect(await engineEval(game, [
      'var player = get_node("/root/Main/Movie")',
      'return [player.get_class(), player.stream.get_class()]',
    ].join('\n'))).toEqual(['VideoStreamPlayer', 'VideoStreamTheora']);

    const played = await game.call('game_video', { action: 'play', nodePath: '/root/Main/Movie' });
    expect(played.isError, played.text).toBe(false);
    expect(await engineEval(game, 'return get_node("/root/Main/Movie").is_playing()')).toBe(true);

    const status = await game.call('game_video', { action: 'get_status', nodePath: '/root/Main/Movie' });
    expect(status.isError, status.text).toBe(false);
    const playing = payload(status.text) as { is_playing: boolean; paused: boolean; length: number };
    expect(playing.is_playing).toBe(true);
    expect(playing.paused).toBe(false);

    const paused = await game.call('game_video', { action: 'pause', nodePath: '/root/Main/Movie' });
    expect(paused.isError, paused.text).toBe(false);
    expect(await engineEval(game, 'return get_node("/root/Main/Movie").paused')).toBe(true);

    const resumed = await game.call('game_video', { action: 'resume', nodePath: '/root/Main/Movie' });
    expect(resumed.isError, resumed.text).toBe(false);
    expect(await engineEval(game, 'return get_node("/root/Main/Movie").paused')).toBe(false);

    const sought = await game.call('game_video', { action: 'seek', nodePath: '/root/Main/Movie', position: 0.2 });
    expect(sought.isError, sought.text).toBe(false);

    const stopped = await game.call('game_video', { action: 'stop', nodePath: '/root/Main/Movie' });
    expect(stopped.isError, stopped.text).toBe(false);
    expect(await engineEval(game, 'return get_node("/root/Main/Movie").is_playing()')).toBe(false);

    const missingResource = await game.call('game_video', {
      action: 'create', parentPath: '/root/Main', videoPath: 'res://absent.ogv',
    });
    expect(missingResource.isError).toBe(true);
    expect(missingResource.text).toMatch(/video resource not found/i);

    const notAVideo = await game.call('game_video', { action: 'play', nodePath: '/root/Main/Anchor' });
    expect(notAVideo.isError).toBe(true);
    expect(notAVideo.text).toMatch(/videostreamplayer not found/i);
  });
});
