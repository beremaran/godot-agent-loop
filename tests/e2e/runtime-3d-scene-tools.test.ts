// @test-kind: e2e
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type E2EServer } from './helpers/harness.js';

/**
 * Full-path E2E coverage for the 3D scene-system tools (CSG, MultiMesh,
 * procedural meshes, 3D lights, GridMap, 3D effects) and the 3D direct-space
 * physics queries. Geometry is verified at the engine level — surface arrays,
 * instance transforms, resource classes, real ray hits — rather than by
 * re-reading the response that produced it.
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

async function startedGame(): Promise<E2EServer> {
  // The tools under test are unprivileged; game_eval is the privileged observer.
  server = await startServer({ allowPrivileged: true });
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

describe('3D scene-system tools through MCP', () => {
  it('game_csg creates every shape type and configures boolean operations', async () => {
    const game = await startedGame();

    expect(await engineEval(game, [
      'var material := StandardMaterial3D.new()',
      'material.albedo_color = Color(0.2, 0.4, 0.6, 1.0)',
      'return ResourceSaver.save(material, "res://csg_material.tres")',
    ].join('\n'))).toBe(0);

    const box = await game.call('game_csg', {
      action: 'create', parentPath: '/root/Main', csgType: 'box', name: 'Block',
      size: { x: 2, y: 3, z: 4 }, operation: 'union', material: 'res://csg_material.tres',
    });
    expect(box.isError, box.text).toBe(false);
    expect(payload(box.text)).toMatchObject({ action: 'create', path: '/root/Main/Block', type: 'box' });

    // Independent observation: a real CSGBox3D with the requested extents and
    // OPERATION_UNION (0).
    const observedBox = await engineEval(game, 'var b = get_node("/root/Main/Block")\nreturn [b.get_class(), b.size.x, b.size.y, b.size.z, b.operation, b.material.albedo_color]') as [string, number, number, number, number, { r: number; g: number; b: number; a: number }];
    expect(observedBox.slice(0, 5)).toEqual(['CSGBox3D', 2, 3, 4, 0]);
    expect(observedBox[5].r).toBeCloseTo(0.2);
    expect(observedBox[5].g).toBeCloseTo(0.4);
    expect(observedBox[5].b).toBeCloseTo(0.6);
    expect(observedBox[5].a).toBe(1);

    const sphere = await game.call('game_csg', {
      action: 'create', parentPath: '/root/Main', csgType: 'sphere', name: 'Ball',
      radius: 1.5, operation: 'subtraction',
    });
    expect(sphere.isError, sphere.text).toBe(false);
    // CSGShape3D.OPERATION_SUBTRACTION is 2.
    expect(await engineEval(game, 'var s = get_node("/root/Main/Ball")\nreturn [s.get_class(), s.radius, s.operation]'))
      .toEqual(['CSGSphere3D', 1.5, 2]);

    const cylinder = await game.call('game_csg', {
      action: 'create', parentPath: '/root/Main', csgType: 'cylinder', name: 'Pipe',
      radius: 0.5, height: 6, operation: 'intersection',
    });
    expect(cylinder.isError, cylinder.text).toBe(false);
    // OPERATION_INTERSECTION is 1.
    expect(await engineEval(game, 'var c = get_node("/root/Main/Pipe")\nreturn [c.get_class(), c.radius, c.height, c.operation]'))
      .toEqual(['CSGCylinder3D', 0.5, 6, 1]);

    for (const [csgType, className] of [['mesh', 'CSGMesh3D'], ['combiner', 'CSGCombiner3D']] as const) {
      const created = await game.call('game_csg', {
        action: 'create', parentPath: '/root/Main', csgType, name: `Csg_${csgType}`,
      });
      expect(created.isError, created.text).toBe(false);
      expect(await engineEval(game, `return get_node("/root/Main/Csg_${csgType}").get_class()`)).toBe(className);
    }

    // configure flips the boolean operation on an existing node.
    const configured = await game.call('game_csg', {
      action: 'configure', nodePath: '/root/Main/Block', operation: 'subtraction',
    });
    expect(configured.isError, configured.text).toBe(false);
    expect(await engineEval(game, 'return get_node("/root/Main/Block").operation')).toBe(2);

    const wrongNode = await game.call('game_csg', {
      action: 'configure', nodePath: '/root/Main/Anchor', operation: 'union',
    });
    expect(wrongNode.isError).toBe(true);
    expect(wrongNode.text).toMatch(/CSGShape3D/i);

    const badType = await game.call('game_csg', {
      action: 'create', parentPath: '/root/Main', csgType: 'torus',
    });
    expect(badType.isError).toBe(true);
    expect(badType.text).toMatch(/csg_type must be one of/i);
  });

  it('game_multimesh creates instances, positions them, and reports counts', async () => {
    const game = await startedGame();

    const created = await game.call('game_multimesh', {
      action: 'create', parentPath: '/root/Main', name: 'Forest', meshType: 'cylinder', count: 4,
    });
    expect(created.isError, created.text).toBe(false);
    expect(payload(created.text)).toMatchObject({ path: '/root/Main/Forest', count: 4 });

    // Independent observation: a real MultiMeshInstance3D whose MultiMesh holds a
    // CylinderMesh and four 3D-format instances.
    expect(await engineEval(game, [
      'var node = get_node("/root/Main/Forest")',
      'var mm: MultiMesh = node.multimesh',
      'return [node.get_class(), mm.mesh.get_class(), mm.instance_count, mm.transform_format]',
    ].join('\n'))).toEqual(['MultiMeshInstance3D', 'CylinderMesh', 4, 1]);

    // Instance transforms live in the rendering server's buffer, which Godot's
    // headless dummy renderer never allocates — a write there is dropped. The
    // tool must SAY so rather than report a success the engine did not perform.
    // (Verified independently: MultiMesh.buffer is empty under --headless even
    // when set from plain GDScript.)
    const instanceDataAvailable = await engineEval(game, [
      'var mm = get_node("/root/Main/Forest").multimesh',
      'return not mm.buffer.is_empty()',
    ].join('\n')) as boolean;

    const placed = await game.call('game_multimesh', {
      action: 'set_instance', nodePath: '/root/Main/Forest', index: 2,
      transform: { origin: { x: 7, y: 0, z: -3 } },
    });

    if (instanceDataAvailable) {
      expect(placed.isError, placed.text).toBe(false);
      expect(payload(placed.text)).toMatchObject({ index: 2 });
      expect(await engineEval(game, [
        'var origin = get_node("/root/Main/Forest").multimesh.get_instance_transform(2).origin',
        'return [origin.x, origin.y, origin.z]',
      ].join('\n'))).toEqual([7, 0, -3]);
    } else {
      expect(placed.isError, placed.text).toBe(true);
      expect(placed.text).toMatch(/instance data is unavailable|instance_buffer_unavailable/i);
      expect(placed.text).toMatch(/renderer|display/i);
    }

    const info = await game.call('game_multimesh', { action: 'get_info', nodePath: '/root/Main/Forest' });
    expect(info.isError, info.text).toBe(false);
    expect(payload(info.text)).toMatchObject({ count: 4, instance_data_available: instanceDataAvailable });

    // An out-of-range index is a structured error, not an engine crash.
    const outOfRange = await game.call('game_multimesh', {
      action: 'set_instance', nodePath: '/root/Main/Forest', index: 99,
      transform: { origin: { x: 0, y: 0, z: 0 } },
    });
    expect(outOfRange.isError).toBe(true);
    expect(outOfRange.text).toMatch(/outside the instance range|out_of_range/i);

    const missing = await game.call('game_multimesh', { action: 'get_info', nodePath: '/root/Main/Anchor' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/multimeshinstance3d not found/i);
  });

  it('game_procedural_mesh builds a surface with vertices, normals, UVs, and indices', async () => {
    const game = await startedGame();

    const built = await game.call('game_procedural_mesh', {
      parentPath: '/root/Main', name: 'Quad',
      vertices: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
      normals: [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]],
      uvs: [[0, 0], [1, 0], [1, 1], [0, 1]],
      indices: [0, 1, 2, 0, 2, 3],
    });
    expect(built.isError, built.text).toBe(false);

    // Independent observation: read the surface arrays back out of the engine.
    const mesh = await engineEval(game, [
      'var node = get_node("/root/Main/Quad")',
      'var arrays: Array = node.mesh.surface_get_arrays(0)',
      'var vertices: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]',
      'var normals: PackedVector3Array = arrays[Mesh.ARRAY_NORMAL]',
      'var uvs: PackedVector2Array = arrays[Mesh.ARRAY_TEX_UV]',
      'var indices: PackedInt32Array = arrays[Mesh.ARRAY_INDEX]',
      'return {',
      '\t"class": node.get_class(),',
      '\t"surfaces": node.mesh.get_surface_count(),',
      '\t"vertex_count": vertices.size(),',
      '\t"third_vertex": [vertices[2].x, vertices[2].y, vertices[2].z],',
      '\t"normal": [normals[0].x, normals[0].y, normals[0].z],',
      '\t"uv": [uvs[2].x, uvs[2].y],',
      '\t"indices": Array(indices),',
      '}',
    ].join('\n')) as Record<string, unknown>;
    expect(mesh).toMatchObject({
      class: 'MeshInstance3D',
      surfaces: 1,
      vertex_count: 4,
      third_vertex: [1, 1, 0],
      uv: [1, 1],
      indices: [0, 1, 2, 0, 2, 3],
    });
    const normal = mesh.normal as number[];
    expect(normal[0]).toBeCloseTo(0, 4);
    expect(normal[1]).toBeCloseTo(0, 4);
    expect(normal[2]).toBeCloseTo(1, 4);

    // Vertices alone are enough; the optional buffers default to absent.
    const minimal = await game.call('game_procedural_mesh', {
      parentPath: '/root/Main', name: 'Tri', vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
    });
    expect(minimal.isError, minimal.text).toBe(false);
    expect(await engineEval(game, 'return get_node("/root/Main/Tri").mesh.surface_get_arrays(0)[Mesh.ARRAY_VERTEX].size()'))
      .toBe(3);

    const badParent = await game.call('game_procedural_mesh', {
      parentPath: '/root/Nowhere', vertices: [[0, 0, 0]],
    });
    expect(badParent.isError).toBe(true);
    expect(badParent.text).toMatch(/parent not found/i);
  });

  it('game_light_3d creates each light type and reconfigures one', async () => {
    const game = await startedGame();

    const omni = await game.call('game_light_3d', {
      action: 'create', parentPath: '/root/Main', lightType: 'omni', name: 'Bulb',
      color: { r: 1, g: 0, b: 0 }, energy: 2.5, range: 12, shadows: true,
    });
    expect(omni.isError, omni.text).toBe(false);
    expect(payload(omni.text)).toMatchObject({ path: '/root/Main/Bulb', type: 'omni' });

    // Independent observation: a real OmniLight3D holding every applied field.
    expect(await engineEval(game, [
      'var light = get_node("/root/Main/Bulb")',
      'return [light.get_class(), light.light_color.r, light.light_color.g, light.light_energy, light.omni_range, light.shadow_enabled]',
    ].join('\n'))).toEqual(['OmniLight3D', 1, 0, 2.5, 12, true]);

    const spot = await game.call('game_light_3d', {
      action: 'create', parentPath: '/root/Main', lightType: 'spot', name: 'Torch',
      range: 20, spotAngle: 35, energy: 1.5,
    });
    expect(spot.isError, spot.text).toBe(false);
    expect(await engineEval(game, [
      'var light = get_node("/root/Main/Torch")',
      'return [light.get_class(), light.spot_range, light.spot_angle, light.light_energy]',
    ].join('\n'))).toEqual(['SpotLight3D', 20, 35, 1.5]);

    const directional = await game.call('game_light_3d', {
      action: 'create', parentPath: '/root/Main', lightType: 'directional', name: 'Sun', shadows: false,
    });
    expect(directional.isError, directional.text).toBe(false);
    expect(await engineEval(game, 'var l = get_node("/root/Main/Sun")\nreturn [l.get_class(), l.shadow_enabled]'))
      .toEqual(['DirectionalLight3D', false]);

    const configured = await game.call('game_light_3d', {
      action: 'configure', nodePath: '/root/Main/Bulb',
      color: { r: 0, g: 0, b: 1 }, energy: 0.5, shadows: false,
    });
    expect(configured.isError, configured.text).toBe(false);
    expect(await engineEval(game, [
      'var light = get_node("/root/Main/Bulb")',
      'return [light.light_color.b, light.light_energy, light.shadow_enabled]',
    ].join('\n'))).toEqual([1, 0.5, false]);

    const badType = await game.call('game_light_3d', {
      action: 'create', parentPath: '/root/Main', lightType: 'laser',
    });
    expect(badType.isError).toBe(true);
    expect(badType.text).toMatch(/unknown light type/i);

    const missing = await game.call('game_light_3d', { action: 'configure', nodePath: '/root/Main/Anchor' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/light3d not found/i);
  });

  it('game_gridmap sets, reads, lists, and clears cells backed by a real MeshLibrary', async () => {
    const game = await startedGame();

    // Author a MeshLibrary through the public headless tool, then bind it to a
    // runtime GridMap; set_cell_item is only meaningful with a library.
    const sourceScene = await game.call('create_scene', {
      projectPath: game.projectPath, scenePath: 'res://tiles.tscn', rootNodeType: 'Node3D',
    });
    expect(sourceScene.isError, sourceScene.text).toBe(false);

    // A MeshInstance3D only counts as a library item once it owns a real mesh.
    const boxMesh = await game.call('create_resource', {
      projectPath: game.projectPath, resourceType: 'BoxMesh', resourcePath: 'res://box.tres',
      properties: { size: { x: 1, y: 1, z: 1 } },
    });
    expect(boxMesh.isError, boxMesh.text).toBe(false);

    const tile = await game.call('add_node', {
      projectPath: game.projectPath, scenePath: 'res://tiles.tscn',
      parentNodePath: 'root', nodeType: 'MeshInstance3D', nodeName: 'Cube',
      properties: { mesh: 'res://box.tres' },
    });
    expect(tile.isError, tile.text).toBe(false);
    const library = await game.call('export_mesh_library', {
      projectPath: game.projectPath, scenePath: 'res://tiles.tscn', outputPath: 'res://tiles.meshlib',
    });
    expect(library.isError, library.text).toBe(false);

    await game.call('game_spawn_node', { type: 'GridMap', name: 'Grid', parentPath: '/root/Main' });
    await engineEval(game, [
      'var grid = get_node("/root/Main/Grid")',
      'grid.mesh_library = load("res://tiles.meshlib")',
      'return grid.mesh_library.get_item_list().size()',
    ].join('\n'));

    const set = await game.call('game_gridmap', {
      nodePath: '/root/Main/Grid', action: 'set_cell', x: 1, y: 0, z: 2, item: 0, orientation: 10,
    });
    expect(set.isError, set.text).toBe(false);

    // Independent observation: the engine's GridMap holds the cell and orientation.
    expect(await engineEval(game, [
      'var grid = get_node("/root/Main/Grid")',
      'return [grid.get_cell_item(Vector3i(1, 0, 2)), grid.get_cell_item_orientation(Vector3i(1, 0, 2))]',
    ].join('\n'))).toEqual([0, 10]);

    const got = await game.call('game_gridmap', { nodePath: '/root/Main/Grid', action: 'get_cell', x: 1, y: 0, z: 2 });
    expect(got.isError, got.text).toBe(false);
    expect(payload(got.text)).toMatchObject({ item: 0 });

    const used = await game.call('game_gridmap', { nodePath: '/root/Main/Grid', action: 'get_used' });
    expect(used.isError, used.text).toBe(false);
    expect(payload(used.text)).toMatchObject({ total: 1, cells: [{ x: 1, y: 0, z: 2 }] });

    const cleared = await game.call('game_gridmap', { nodePath: '/root/Main/Grid', action: 'clear' });
    expect(cleared.isError, cleared.text).toBe(false);
    expect(await engineEval(game, 'return get_node("/root/Main/Grid").get_used_cells().size()')).toBe(0);

    const empty = await game.call('game_gridmap', { nodePath: '/root/Main/Grid', action: 'get_used' });
    expect(payload(empty.text)).toMatchObject({ total: 0, cells: [] });

    const notAGrid = await game.call('game_gridmap', { nodePath: '/root/Main/Anchor', action: 'get_used' });
    expect(notAGrid.isError).toBe(true);
    expect(notAGrid.text).toMatch(/gridmap not found/i);
  });

  it('game_3d_effects creates decals, fog volumes, and reflection probes', async () => {
    const game = await startedGame();

    for (const [effectType, className] of [
      ['decal', 'Decal'], ['fog_volume', 'FogVolume'], ['reflection_probe', 'ReflectionProbe'],
    ] as const) {
      const created = await game.call('game_3d_effects', {
        parentPath: '/root/Main', effectType, name: `FX_${effectType}`,
        size: { x: 3, y: 4, z: 5 }, intensity: 0.35,
      });
      expect(created.isError, created.text).toBe(false);
      expect(payload(created.text)).toMatchObject({ path: `/root/Main/FX_${effectType}`, effect_type: effectType });

      // Independent observation: the engine holds the node class and its size.
      const observed = await engineEval(game, [
        `var node = get_node("/root/Main/FX_${effectType}")`,
        'var intensity = node.intensity if node is ReflectionProbe else (node.albedo_mix if node is Decal else node.material.density)',
        'return [node.get_class(), node.size.x, node.size.y, node.size.z, intensity]',
      ].join('\n')) as [string, number, number, number, number];
      expect(observed.slice(0, 4)).toEqual([className, 3, 4, 5]);
      expect(observed[4]).toBeCloseTo(0.35);
    }

    const badType = await game.call('game_3d_effects', { parentPath: '/root/Main', effectType: 'godrays' });
    expect(badType.isError).toBe(true);
    expect(badType.text).toMatch(/unknown effect type/i);

    const badParent = await game.call('game_3d_effects', { parentPath: '/root/Nowhere', effectType: 'decal' });
    expect(badParent.isError).toBe(true);
    expect(badParent.text).toMatch(/parent not found/i);
  });
});

describe('3D physics queries through MCP', () => {
  it('game_physics_3d ray hits a real collider, respects masks, and misses empty space', async () => {
    const game = await startedGame();

    // The fixture's StaticBody3D has no shape; give it one through the public tool.
    const collider = await game.call('game_add_collision', {
      parentPath: '/root/Main/Physics3D/Wall', shapeType: 'box',
      shapeParams: { size_x: 2, size_y: 2, size_z: 2 }, collisionLayer: 1,
    });
    expect(collider.isError, collider.text).toBe(false);

    const hit = await game.call('game_physics_3d', {
      action: 'ray', from: { x: 0, y: 0, z: 10 }, to: { x: 0, y: 0, z: -10 },
    });
    expect(hit.isError, hit.text).toBe(false);
    const result = payload(hit.text) as { hit: boolean; collider: string; position: { z: number } };
    expect(result.hit).toBe(true);
    expect(result.collider).toContain('Wall');
    // The box half-extent is 1, so the front face sits at z = 1.
    expect(result.position.z).toBeCloseTo(1, 3);

    // A ray through empty space misses.
    const miss = await game.call('game_physics_3d', {
      action: 'ray', from: { x: 50, y: 50, z: 10 }, to: { x: 50, y: 50, z: -10 },
    });
    expect(miss.isError, miss.text).toBe(false);
    expect(payload(miss.text)).toMatchObject({ hit: false });

    // A mask that excludes the body's layer must not hit it.
    const masked = await game.call('game_physics_3d', {
      action: 'ray', from: { x: 0, y: 0, z: 10 }, to: { x: 0, y: 0, z: -10 }, collisionMask: 2,
    });
    expect(masked.isError, masked.text).toBe(false);
    expect(payload(masked.text)).toMatchObject({ hit: false });
  });

  it('game_physics_3d overlap reports bodies inside an Area3D', async () => {
    const game = await startedGame();

    await game.call('game_spawn_node', {
      type: 'Area3D', name: 'Sensor', parentPath: '/root/Main/Physics3D',
    });
    const areaShape = await game.call('game_add_collision', {
      parentPath: '/root/Main/Physics3D/Sensor', shapeType: 'box',
      shapeParams: { size_x: 6, size_y: 6, size_z: 6 },
    });
    expect(areaShape.isError, areaShape.text).toBe(false);

    // A body sharing the Area's space, so the overlap has something real to find.
    const bodyShape = await game.call('game_add_collision', {
      parentPath: '/root/Main/Physics3D/Wall', shapeType: 'sphere', shapeParams: { radius: 1 },
    });
    expect(bodyShape.isError, bodyShape.text).toBe(false);

    // Overlaps are resolved by the physics server, so let it step.
    await game.call('game_wait', { frames: 5, frameType: 'physics' });

    const overlap = await game.call('game_physics_3d', {
      action: 'overlap', nodePath: '/root/Main/Physics3D/Sensor',
    });
    expect(overlap.isError, overlap.text).toBe(false);
    const bodies = (payload(overlap.text) as { bodies: { name: string; path: string }[] }).bodies;
    expect(bodies.map(body => body.name)).toContain('Wall');

    const notAnArea = await game.call('game_physics_3d', {
      action: 'overlap', nodePath: '/root/Main/Anchor',
    });
    expect(notAnArea.isError).toBe(true);
    expect(notAnArea.text).toMatch(/Area3D/i);
  });
});
