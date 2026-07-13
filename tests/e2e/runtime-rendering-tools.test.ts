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

describe('runtime G+ rendering tools through MCP', () => {
  it('game_environment set/get agrees with the owned Godot Environment resource', async () => {
    const game = await startedGame();
    const settings = {
      action: 'set',
      backgroundMode: 1,
      backgroundColor: { r: 0.12, g: 0.23, b: 0.34, a: 0.9 },
      ambientLightColor: { r: 0.4, g: 0.5, b: 0.6, a: 1 },
      ambientLightEnergy: 1.75,
      fogEnabled: true,
      fogDensity: 0.02,
      fogLightColor: { r: 0.7, g: 0.6, b: 0.5, a: 1 },
      glowEnabled: false,
      glowIntensity: 1.25,
      glowBloom: 0.15,
      tonemapMode: 2,
      ssaoEnabled: false,
      ssaoRadius: 2.5,
      ssaoIntensity: 1.4,
      ssrEnabled: false,
      brightness: 1.1,
      contrast: 0.9,
      saturation: 0.8,
    };
    const set = await game.call('game_environment', settings);
    expect(set.isError, set.text).toBe(false);
    expect(payload(set.text)).toMatchObject({
      success: true,
      background_mode: 1,
      fog_enabled: true,
      ambient_light_energy: 1.75,
    });

    const get = await game.call('game_environment', { action: 'get' });
    expect(get.isError, get.text).toBe(false);
    const state = payload(get.text) as {
      background_color: Record<'r' | 'g' | 'b' | 'a', number>;
      fog_density: number;
      brightness: number;
      contrast: number;
      saturation: number;
      fog_light_color: Record<'r' | 'g' | 'b' | 'a', number>;
      glow_enabled: boolean;
      glow_intensity: number;
      glow_bloom: number;
      tonemap_mode: number;
      ssao_enabled: boolean;
      ssao_radius: number;
      ssao_intensity: number;
      ssr_enabled: boolean;
    };
    expect(state.background_color.r).toBeCloseTo(0.12);
    expect(state.background_color.g).toBeCloseTo(0.23);
    expect(state.background_color.b).toBeCloseTo(0.34);
    expect(state.background_color.a).toBeCloseTo(0.9);
    expect(state.fog_density).toBeCloseTo(0.02);
    expect(state.brightness).toBeCloseTo(1.1);
    expect(state.contrast).toBeCloseTo(0.9);
    expect(state.saturation).toBeCloseTo(0.8);
    expect(state.fog_light_color.r).toBeCloseTo(0.7);
    expect(state.glow_enabled).toBe(false);
    expect(state.glow_intensity).toBeCloseTo(1.25);
    expect(state.glow_bloom).toBeCloseTo(0.15);
    expect(state.tonemap_mode).toBe(2);
    expect(state.ssao_enabled).toBe(false);
    expect(state.ssao_radius).toBeCloseTo(2.5);
    expect(state.ssao_intensity).toBeCloseTo(1.4);
    expect(state.ssr_enabled).toBe(false);

    const observed = await evalResult(game, [
      'var world := get_tree().root.find_children("*", "WorldEnvironment", true, false)[0] as WorldEnvironment',
      'var env := world.environment',
      'return {"mode": env.background_mode, "color": env.background_color, "energy": env.ambient_light_energy, "fog": env.fog_enabled, "density": env.fog_density, "fog_color": env.fog_light_color, "glow_intensity": env.glow_intensity, "tonemap": env.tonemap_mode, "ssao_radius": env.ssao_radius, "adjustment": env.adjustment_enabled}',
    ].join('\n'));
    const resource = observed as {
      mode: number;
      color: Record<'r' | 'g' | 'b' | 'a', number>;
      energy: number;
      fog: boolean;
      density: number;
      adjustment: boolean;
      fog_color: Record<'r' | 'g' | 'b' | 'a', number>;
      glow_intensity: number;
      tonemap: number;
      ssao_radius: number;
    };
    expect(resource.mode).toBe(1);
    expect(resource.color.r).toBeCloseTo(0.12);
    expect(resource.color.g).toBeCloseTo(0.23);
    expect(resource.color.b).toBeCloseTo(0.34);
    expect(resource.color.a).toBeCloseTo(0.9);
    expect(resource.energy).toBeCloseTo(1.75);
    expect(resource.fog).toBe(true);
    expect(resource.density).toBeCloseTo(0.02);
    expect(resource.adjustment).toBe(true);
    expect(resource.fog_color.r).toBeCloseTo(0.7);
    expect(resource.glow_intensity).toBeCloseTo(1.25);
    expect(resource.tonemap).toBe(2);
    expect(resource.ssao_radius).toBeCloseTo(2.5);

    await expect(game.client.callTool({
      name: 'game_environment', arguments: { action: 'explode' },
    })).rejects.toThrow(/action.*get/i);
  });

  it('game_debug_draw creates every geometry, expires durations, and clears owned nodes', async () => {
    const game = await startedGame();
    expect((await game.call('game_debug_draw', {
      action: 'line', from: { x: 1, y: 2, z: 3 }, to: { x: 4, y: 5, z: 6 },
      color: { r: 0.2, g: 0.4, b: 0.6, a: 0.5 },
    })).isError).toBe(false);
    expect((await game.call('game_debug_draw', {
      action: 'sphere', center: { x: 7, y: 8, z: 9 }, radius: 1.25,
    })).isError).toBe(false);
    expect((await game.call('game_debug_draw', {
      action: 'box', center: { x: -1, y: -2, z: -3 }, size: { x: 2, y: 4, z: 6 },
    })).isError).toBe(false);

    const geometry = await evalResult(game, [
      'var parent := get_tree().root.get_node("_McpDebugDraw")',
      'var result: Array = []',
      'for child in parent.get_children():',
      '\tvar mesh: Mesh = child.mesh',
      '\tresult.append({"mesh": mesh.get_class(), "position": child.global_position, "surfaces": mesh.get_surface_count()})',
      'return result',
    ].join('\n')) as { mesh: string; position: { x: number; y: number; z: number }; surfaces: number }[];
    expect(geometry.map(item => item.mesh)).toEqual(['ImmediateMesh', 'SphereMesh', 'BoxMesh']);
    expect(geometry.map(item => item.position)).toEqual([
      { x: 0, y: 0, z: 0 },
      { x: 7, y: 8, z: 9 },
      { x: -1, y: -2, z: -3 },
    ]);
    expect(geometry.every(item => item.surfaces === 1)).toBe(true);

    expect((await game.call('game_debug_draw', {
      action: 'sphere', center: { x: 20, y: 0, z: 0 }, duration: 30,
    })).isError).toBe(false);
    expect(await evalResult(game, 'return get_tree().root.get_node("_McpDebugDraw").get_child_count()')).toBe(4);
    expect((await game.call('game_wait', { frames: 35 })).isError).toBe(false);
    expect(await evalResult(game, 'return get_tree().root.get_node("_McpDebugDraw").get_child_count()')).toBe(3);

    const cleared = await game.call('game_debug_draw', { action: 'clear' });
    expect(cleared.isError, cleared.text).toBe(false);
    await game.call('game_wait', { frames: 1 });
    expect(await evalResult(game, 'return get_tree().root.has_node("_McpDebugDraw")')).toBe(false);

    await expect(game.client.callTool({
      name: 'game_debug_draw', arguments: { action: 'line', duration: -1 },
    })).rejects.toThrow(/duration must be at least 0/i);
    const zeroRadius = await game.call('game_debug_draw', { action: 'sphere', radius: 0 });
    expect(zeroRadius.isError).toBe(true);
    expect(zeroRadius.text).toMatch(/greater than zero/i);
  });

  it('game_visual_shader covers graph edits, connection state, application, and failures', async () => {
    const game = await startedGame();
    const created = await game.call('game_visual_shader', { action: 'create', shaderType: 'spatial' });
    expect(created.isError, created.text).toBe(false);
    const shaderId = (payload(created.text) as { shader_id: number }).shader_id;

    const constant = await game.call('game_visual_shader', {
      action: 'add_node', shaderId, nodeClass: 'VisualShaderNodeFloatConstant', position: { x: 100, y: 200 },
    });
    const operation = await game.call('game_visual_shader', {
      action: 'add_node', shaderId, nodeClass: 'VisualShaderNodeFloatOp', position: { x: 300, y: 200 },
    });
    expect(constant.isError, constant.text).toBe(false);
    expect(operation.isError, operation.text).toBe(false);
    const fromNode = (payload(constant.text) as { node_id: number }).node_id;
    const toNode = (payload(operation.text) as { node_id: number }).node_id;
    const edge = { shaderId, fromNode, fromPort: 0, toNode, toPort: 0 };

    const connected = await game.call('game_visual_shader', { action: 'connect', ...edge });
    expect(connected.isError, connected.text).toBe(false);
    const connectionCode = [
      'var domain := get_tree().root.get_node("McpInteractionServer/rendering_domain")',
      `var shader: VisualShader = domain.get("_visual_shaders").get(${shaderId})`,
      `return shader.is_node_connection(VisualShader.TYPE_FRAGMENT, ${fromNode}, 0, ${toNode}, 0)`,
    ].join('\n');
    expect(await evalResult(game, connectionCode)).toBe(true);

    const nodes = await game.call('game_visual_shader', { action: 'get_nodes', shaderId });
    expect(nodes.isError, nodes.text).toBe(false);
    expect((payload(nodes.text) as { nodes: unknown[] }).nodes).toHaveLength(3);

    const disconnected = await game.call('game_visual_shader', { action: 'disconnect', ...edge });
    expect(disconnected.isError, disconnected.text).toBe(false);
    expect(await evalResult(game, connectionCode)).toBe(false);
    const duplicateDisconnect = await game.call('game_visual_shader', { action: 'disconnect', ...edge });
    expect(duplicateDisconnect.isError).toBe(true);
    expect(duplicateDisconnect.text).toMatch(/connection does not exist/i);

    const applied = await game.call('game_visual_shader', {
      action: 'apply', shaderId, nodePath: '/root/Main/VisualTarget',
    });
    expect(applied.isError, applied.text).toBe(false);
    expect(await evalResult(game, [
      'var target := get_tree().root.get_node("Main/VisualTarget") as MeshInstance3D',
      'return {"material": target.material_override.get_class(), "shader": target.material_override.shader.get_class(), "mode": target.material_override.shader.get_mode()}',
    ].join('\n'))).toEqual({ material: 'ShaderMaterial', shader: 'VisualShader', mode: 0 });

    const missingTarget = await game.call('game_visual_shader', {
      action: 'apply', shaderId, nodePath: '/root/Main/DefinitelyMissing',
    });
    expect(missingTarget.isError).toBe(true);
    expect(missingTarget.text).toMatch(/not found/i);

    const missingPorts = await game.call('game_visual_shader', {
      action: 'connect', shaderId, fromNode, toNode,
    });
    expect(missingPorts.isError).toBe(true);
    expect(missingPorts.text).toMatch(/from_port is required/i);
    const badClass = await game.call('game_visual_shader', {
      action: 'add_node', shaderId, nodeClass: 'Node',
    });
    expect(badClass.isError).toBe(true);
    expect(badClass.text).toMatch(/not a VisualShaderNode/i);
  });
});
