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

describe('runtime G+ 3D scene tools through MCP', () => {
  it('game_mesh_instance creates every primitive with its configured resource properties', async () => {
    const game = await startedGame();
    const meshes = [
      { meshType: 'box', name: 'Box3D', size: { x: 2, y: 3, z: 4 } },
      { meshType: 'sphere', name: 'Sphere3D', radius: 1.25, height: 3 },
      { meshType: 'cylinder', name: 'Cylinder3D', radius: 1.5, height: 4 },
      { meshType: 'capsule', name: 'Capsule3D', radius: 0.75, height: 3.5 },
      { meshType: 'plane', name: 'Plane3D', size: { x: 5, y: 1, z: 7 } },
      { meshType: 'quad', name: 'Quad3D', size: { x: 6, y: 8, z: 1 }, material: '#336699cc' },
    ];
    for (const mesh of meshes) {
      const result = await game.call('game_mesh_instance', { parentPath: '/root/Main', ...mesh });
      expect(result.isError, `${mesh.meshType}: ${result.text}`).toBe(false);
    }

    const state = await evalResult(game, [
      'var box := (get_tree().root.get_node("Main/Box3D") as MeshInstance3D).mesh as BoxMesh',
      'var sphere := (get_tree().root.get_node("Main/Sphere3D") as MeshInstance3D).mesh as SphereMesh',
      'var cylinder := (get_tree().root.get_node("Main/Cylinder3D") as MeshInstance3D).mesh as CylinderMesh',
      'var capsule := (get_tree().root.get_node("Main/Capsule3D") as MeshInstance3D).mesh as CapsuleMesh',
      'var plane := (get_tree().root.get_node("Main/Plane3D") as MeshInstance3D).mesh as PlaneMesh',
      'var quad_node := get_tree().root.get_node("Main/Quad3D") as MeshInstance3D',
      'var quad := quad_node.mesh as QuadMesh',
      'var material := quad_node.material_override as StandardMaterial3D',
      'return {"box": box.size, "sphere": [sphere.radius, sphere.height], "cylinder": [cylinder.top_radius, cylinder.bottom_radius, cylinder.height], "capsule": [capsule.radius, capsule.height], "plane": plane.size, "quad": quad.size, "color": material.albedo_color}',
    ].join('\n')) as Record<string, unknown>;
    expect(state).toMatchObject({
      box: { x: 2, y: 3, z: 4 },
      sphere: [1.25, 3],
      cylinder: [1.5, 1.5, 4],
      capsule: [0.75, 3.5],
      plane: { x: 5, y: 7 },
      quad: { x: 6, y: 8 },
    });
    expect((state.color as { r: number }).r).toBeCloseTo(0.2, 2);

    await expect(game.call('game_mesh_instance', {
      parentPath: '/root/Main', meshType: 'pyramid',
    })).rejects.toThrow(/meshType.*box.*sphere/i);
  });

  it('game_path_3d covers create/add/get/set and rejects missing mutation payloads', async () => {
    const game = await startedGame();
    const created = await game.call('game_path_3d', {
      action: 'create', parentPath: '/root/Main', name: 'Route3D',
      points: [{ x: 0, y: 1, z: 2 }, { x: 3, y: 4, z: 5 }],
    });
    expect(created.isError, created.text).toBe(false);
    expect((await game.call('game_path_3d', {
      action: 'add_point', nodePath: '/root/Main/Route3D', point: { x: 6, y: 7, z: 8 },
    })).isError).toBe(false);
    const added = await game.call('game_path_3d', { action: 'get_points', nodePath: '/root/Main/Route3D' });
    expect(payload(added.text)).toMatchObject({
      points: [{ x: 0, y: 1, z: 2 }, { x: 3, y: 4, z: 5 }, { x: 6, y: 7, z: 8 }],
    });

    expect((await game.call('game_path_3d', {
      action: 'set_points', nodePath: '/root/Main/Route3D',
      points: [{ x: -1, y: 0, z: 2 }, { x: 4, y: 2, z: 9 }],
    })).isError).toBe(false);
    const replaced = await game.call('game_path_3d', { action: 'get_points', nodePath: '/root/Main/Route3D' });
    expect(payload(replaced.text)).toMatchObject({
      points: [{ x: -1, y: 0, z: 2 }, { x: 4, y: 2, z: 9 }],
    });
    expect(await evalResult(game, [
      'var path := get_tree().root.get_node("Main/Route3D") as Path3D',
      'return {"class": path.curve.get_class(), "count": path.curve.point_count, "last": path.curve.get_point_position(1), "length": path.curve.get_baked_length()}',
    ].join('\n'))).toMatchObject({ class: 'Curve3D', count: 2, last: { x: 4, y: 2, z: 9 } });

    const missingPoint = await game.call('game_path_3d', { action: 'add_point', nodePath: '/root/Main/Route3D' });
    expect(missingPoint.isError).toBe(true);
    expect(missingPoint.text).toMatch(/point is required/i);
  });

  it('game_terrain covers create/get/modify/paint through rebuilt mesh arrays', async () => {
    const game = await startedGame();
    const created = await game.call('game_terrain', {
      action: 'create', parentPath: '/root/Main', name: 'Terrain3D', width: 3, depth: 3, maxHeight: 1.5,
      heightData: [0, 0, 0, 0, 2, 0, 0, 0, 0],
    });
    expect(created.isError, created.text).toBe(false);
    const initial = await game.call('game_terrain', {
      action: 'get_height', nodePath: '/root/Main/Terrain3D', x: 1, z: 1,
    });
    expect(payload(initial.text)).toMatchObject({ height: 3 });

    expect((await game.call('game_terrain', {
      action: 'modify', nodePath: '/root/Main/Terrain3D', x: 1, z: 1, radius: 0, heightDelta: 2,
    })).isError).toBe(false);
    expect((await game.call('game_terrain', {
      action: 'paint', nodePath: '/root/Main/Terrain3D', x: 1, z: 1, radius: 0,
      color: { r: 0.9, g: 0.1, b: 0.2, a: 1 },
    })).isError).toBe(false);
    const modified = await game.call('game_terrain', {
      action: 'get_height', nodePath: '/root/Main/Terrain3D', x: 1, z: 1,
    });
    expect(payload(modified.text)).toMatchObject({ height: 5 });

    const meshState = await evalResult(game, [
      'var terrain := get_tree().root.get_node("Main/Terrain3D") as MeshInstance3D',
      'var arrays := terrain.mesh.surface_get_arrays(0)',
      'var vertices: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]',
      'var colors: PackedColorArray = arrays[Mesh.ARRAY_COLOR]',
      'var max_y := -INF',
      'var painted := 0',
      'for vertex in vertices:',
      '\tmax_y = maxf(max_y, vertex.y)',
      'for color in colors:',
      '\tif color.r > 0.89 and color.g < 0.11:',
      '\t\tpainted += 1',
      'return {"mesh": terrain.mesh.get_class(), "vertices": vertices.size(), "colors": colors.size(), "max_y": max_y, "painted": painted}',
    ].join('\n'));
    expect(meshState).toMatchObject({ mesh: 'ArrayMesh', vertices: 24, colors: 24, max_y: 5 });
    expect((meshState as { painted: number }).painted).toBeGreaterThan(0);

    const missingBrush = await game.call('game_terrain', {
      action: 'modify', nodePath: '/root/Main/Terrain3D', x: 1, z: 1,
    });
    expect(missingBrush.isError).toBe(true);
    expect(missingBrush.text).toMatch(/radius.*heightDelta.*required/i);
  });
});
