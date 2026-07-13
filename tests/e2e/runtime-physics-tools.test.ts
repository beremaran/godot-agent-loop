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

async function addCollision(
  game: E2EServer,
  parentPath: string,
  shapeType: string,
  shapeParams: Record<string, number>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const result = await game.call('game_add_collision', { parentPath, shapeType, shapeParams, ...extra });
  expect(result.isError, result.text).toBe(false);
}

describe('runtime G+ physics tools through MCP', () => {
  it('game_add_collision, game_raycast, and every game_physics_2d query observe real collision state', async () => {
    const game = await startedGame();
    await addCollision(game, '/root/Main/Physics2D/Wall', 'box', { size_x: 10, size_y: 20 }, {
      collisionLayer: 2, collisionMask: 3, disabled: false,
    });
    await addCollision(game, '/root/Main/Physics2D/Crate', 'circle', { radius: 4 });
    await addCollision(game, '/root/Main/Physics2D/Sensor', 'circle', { radius: 8 });
    await addCollision(game, '/root/Main/Physics3D/Wall', 'sphere', { radius: 2 });
    await addCollision(game, '/root/Main/Physics3D/Crate', 'box', { size_x: 2, size_y: 4, size_z: 6 });
    await game.call('game_wait', { frames: 3, frameType: 'physics' });

    const shapes = await evalResult(game, [
      'var wall := get_tree().root.get_node("Main/Physics2D/Wall") as StaticBody2D',
      'var wall_shape := wall.get_child(0) as CollisionShape2D',
      'var crate3d := get_tree().root.get_node("Main/Physics3D/Crate") as RigidBody3D',
      'var crate_shape := crate3d.get_child(0) as CollisionShape3D',
      'return {"wall_class": wall_shape.shape.get_class(), "wall_size": wall_shape.shape.size, "layer": wall.collision_layer, "mask": wall.collision_mask, "disabled": wall_shape.disabled, "crate_class": crate_shape.shape.get_class(), "crate_size": crate_shape.shape.size}',
    ].join('\n'));
    expect(shapes).toEqual({
      wall_class: 'RectangleShape2D', wall_size: { x: 10, y: 20 }, layer: 2, mask: 3, disabled: false,
      crate_class: 'BoxShape3D', crate_size: { x: 2, y: 4, z: 6 },
    });

    const ray2d = await game.call('game_raycast', {
      from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, collisionMask: 2,
    });
    expect(ray2d.isError, ray2d.text).toBe(false);
    expect(payload(ray2d.text)).toMatchObject({
      hit: true, mode: '2d', collider_path: '/root/Main/Physics2D/Wall', collider_class: 'StaticBody2D',
    });
    const ray3d = await game.call('game_raycast', {
      from: { x: 0, y: 0, z: -10 }, to: { x: 0, y: 0, z: 10 },
    });
    expect(ray3d.isError, ray3d.text).toBe(false);
    expect(payload(ray3d.text)).toMatchObject({
      hit: true, mode: '3d', collider_path: '/root/Main/Physics3D/Wall', collider_class: 'StaticBody3D',
    });

    const directRay = await game.call('game_physics_2d', {
      action: 'ray', from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, collisionMask: 2,
    });
    expect(directRay.isError, directRay.text).toBe(false);
    expect(payload(directRay.text)).toMatchObject({ action: 'ray', hit: true });

    const point = await game.call('game_physics_2d', {
      action: 'point_query', position: { x: 50, y: 0 }, maxResults: 10,
    });
    expect(point.isError, point.text).toBe(false);
    expect((payload(point.text) as { count: number }).count).toBeGreaterThanOrEqual(3);

    const shape = await game.call('game_physics_2d', {
      action: 'shape_query', shapeType: 'rectangle', size: { x: 20, y: 20 }, position: { x: 50, y: 0 },
    });
    expect(shape.isError, shape.text).toBe(false);
    expect((payload(shape.text) as { count: number }).count).toBeGreaterThanOrEqual(3);

    const overlap = await game.call('game_physics_2d', {
      action: 'overlap', nodePath: '/root/Main/Physics2D/Sensor',
    });
    expect(overlap.isError, overlap.text).toBe(false);
    expect(overlap.text).toContain('/root/Main/Physics2D/Crate');

    await expect(game.client.callTool({
      name: 'game_raycast', arguments: { from: { x: 0, y: 0 } },
    })).rejects.toThrow(/to is required/i);
    const badParent = await game.call('game_add_collision', {
      parentPath: '/root/Main/Anchor', shapeType: 'box', shapeParams: {},
    });
    expect(badParent.isError).toBe(true);
    expect(badParent.text).toMatch(/CollisionObject2D or CollisionObject3D/i);
  });

  it('game_physics_body and game_create_joint configure both dimensions and every joint type', async () => {
    const game = await startedGame();
    const body2d = await game.call('game_physics_body', {
      nodePath: '/root/Main/Physics2D/Crate', mass: 4, gravityScale: 0.5,
      linearVelocity: { x: 3, y: -1 }, angularVelocity: 1.25,
      linearDamp: 0.2, angularDamp: 0.3, friction: 0.4, bounce: 0.6, freeze: true, sleeping: false,
    });
    expect(body2d.isError, body2d.text).toBe(false);
    const body3d = await game.call('game_physics_body', {
      nodePath: '/root/Main/Physics3D/Crate', mass: 5, gravityScale: 0.75,
      linearVelocity: { x: 1, y: 2, z: 3 }, angularVelocity: { x: 0.1, y: 0.2, z: 0.3 },
      friction: 0.25, bounce: 0.5, freeze: true,
    });
    expect(body3d.isError, body3d.text).toBe(false);

    const bodies = await evalResult(game, [
      'var body2 := get_tree().root.get_node("Main/Physics2D/Crate") as RigidBody2D',
      'var body3 := get_tree().root.get_node("Main/Physics3D/Crate") as RigidBody3D',
      'return {"mass2": body2.mass, "gravity2": body2.gravity_scale, "velocity2": body2.linear_velocity, "angular2": body2.angular_velocity, "damp2": body2.linear_damp, "angular_damp2": body2.angular_damp, "friction2": body2.physics_material_override.friction, "bounce2": body2.physics_material_override.bounce, "freeze2": body2.freeze, "mass3": body3.mass, "velocity3": body3.linear_velocity, "angular3": body3.angular_velocity, "friction3": body3.physics_material_override.friction, "bounce3": body3.physics_material_override.bounce, "freeze3": body3.freeze}',
    ].join('\n')) as Record<string, unknown>;
    expect(bodies).toMatchObject({
      mass2: 4, gravity2: 0.5, velocity2: { x: 3, y: -1 }, angular2: 1.25,
      freeze2: true, mass3: 5, velocity3: { x: 1, y: 2, z: 3 },
      friction3: 0.25, bounce3: 0.5, freeze3: true,
    });
    expect(bodies.damp2 as number).toBeCloseTo(0.2);
    expect(bodies.angular_damp2 as number).toBeCloseTo(0.3);
    expect(bodies.friction2 as number).toBeCloseTo(0.4);
    expect(bodies.bounce2 as number).toBeCloseTo(0.6);
    const angular3 = bodies.angular3 as { x: number; y: number; z: number };
    expect(angular3.x).toBeCloseTo(0.1);
    expect(angular3.y).toBeCloseTo(0.2);
    expect(angular3.z).toBeCloseTo(0.3);

    const joints = [
      { parentPath: '/root/Main/Physics2D', jointType: 'pin_2d', nodeAPath: '../Wall', nodeBPath: '../Crate', softness: 1.5 },
      { parentPath: '/root/Main/Physics2D', jointType: 'spring_2d', nodeAPath: '../Wall', nodeBPath: '../Crate', length: 8, restLength: 6, stiffness: 12, damping: 0.8 },
      { parentPath: '/root/Main/Physics2D', jointType: 'groove_2d', nodeAPath: '../Wall', nodeBPath: '../Crate', length: 10, initialOffset: 2 },
      { parentPath: '/root/Main/Physics3D', jointType: 'pin_3d', nodeAPath: '../Wall', nodeBPath: '../Crate' },
      { parentPath: '/root/Main/Physics3D', jointType: 'hinge_3d', nodeAPath: '../Wall', nodeBPath: '../Crate' },
      { parentPath: '/root/Main/Physics3D', jointType: 'cone_3d', nodeAPath: '../Wall', nodeBPath: '../Crate' },
      { parentPath: '/root/Main/Physics3D', jointType: 'slider_3d', nodeAPath: '../Wall', nodeBPath: '../Crate' },
    ];
    for (const joint of joints) {
      const result = await game.call('game_create_joint', joint);
      expect(result.isError, `${joint.jointType}: ${result.text}`).toBe(false);
    }

    const observedJoints = await evalResult(game, [
      'var result: Array = []',
      'for parent_path in ["Main/Physics2D", "Main/Physics3D"]:',
      '\tfor child in get_tree().root.get_node(parent_path).get_children():',
      '\t\tif child is Joint2D or child is Joint3D:',
      '\t\t\tresult.append(child.get_class())',
      'return result',
    ].join('\n')) as string[];
    expect(observedJoints).toEqual([
      'PinJoint2D', 'DampedSpringJoint2D', 'GrooveJoint2D',
      'PinJoint3D', 'HingeJoint3D', 'ConeTwistJoint3D', 'SliderJoint3D',
    ]);

    const badEndpoint = await game.call('game_create_joint', {
      parentPath: '/root/Main/Physics2D', jointType: 'pin_2d', nodeAPath: '../Missing', nodeBPath: '../Crate',
    });
    expect(badEndpoint.isError).toBe(true);
    expect(badEndpoint.text).toMatch(/endpoint is not a matching physics body/i);
  });

  it('game_add_collision constructs the remaining capsule, cylinder, and segment enum shapes', async () => {
    const game = await startedGame();
    await game.call('game_spawn_node', { type: 'StaticBody3D', name: 'CapsuleOwner', parentPath: '/root/Main/Physics3D' });
    await game.call('game_spawn_node', { type: 'StaticBody3D', name: 'CylinderOwner', parentPath: '/root/Main/Physics3D' });
    await game.call('game_spawn_node', { type: 'StaticBody2D', name: 'SegmentOwner', parentPath: '/root/Main/Physics2D' });
    expect((await game.call('game_add_collision', {
      parentPath: '/root/Main/Physics3D/CapsuleOwner', shapeType: 'capsule', shapeParams: { radius: 0.4, height: 1.8 },
    })).isError).toBe(false);
    expect((await game.call('game_add_collision', {
      parentPath: '/root/Main/Physics3D/CylinderOwner', shapeType: 'cylinder', shapeParams: { radius: 0.7, height: 2.5 },
    })).isError).toBe(false);
    expect((await game.call('game_add_collision', {
      parentPath: '/root/Main/Physics2D/SegmentOwner', shapeType: 'segment', shapeParams: { a_x: -2, a_y: 1, b_x: 3, b_y: 4 },
    })).isError).toBe(false);
    const observed = await evalResult(game, [
      'var capsule = get_node("/root/Main/Physics3D/CapsuleOwner").get_child(0).shape',
      'var cylinder = get_node("/root/Main/Physics3D/CylinderOwner").get_child(0).shape',
      'var segment = get_node("/root/Main/Physics2D/SegmentOwner").get_child(0).shape',
      'return [capsule.get_class(), capsule.radius, capsule.height, cylinder.get_class(), cylinder.radius, cylinder.height, segment.get_class(), segment.a, segment.b]',
    ].join('\n')) as [string, number, number, string, number, number, string, { x: number; y: number }, { x: number; y: number }];
    expect(observed[0]).toBe('CapsuleShape3D');
    expect(observed[1]).toBeCloseTo(0.4);
    expect(observed[2]).toBeCloseTo(1.8);
    expect(observed[3]).toBe('CylinderShape3D');
    expect(observed[4]).toBeCloseTo(0.7);
    expect(observed[5]).toBeCloseTo(2.5);
    expect(observed.slice(6)).toEqual(['SegmentShape2D', { x: -2, y: 1 }, { x: 3, y: 4 }]);
  });

  it('game_navigation_3d bakes geometry and game_navigate_path produces an actual 2D path', async () => {
    const game = await startedGame();
    const create = await game.call('game_navigation_3d', {
      action: 'create', parentPath: '/root', name: 'NavRegion',
      cellSize: 0.25, agentRadius: 0.2, agentHeight: 1,
    });
    expect(create.isError, create.text).toBe(false);
    await evalResult(game, [
      'var region := get_tree().root.get_node("NavRegion") as NavigationRegion3D',
      'var floor := MeshInstance3D.new()',
      'var mesh := PlaneMesh.new()',
      'mesh.size = Vector2(20, 20)',
      'floor.mesh = mesh',
      'region.add_child(floor)',
      'return floor.get_path()',
    ].join('\n'));
    const baked = await game.call('game_navigation_3d', {
      action: 'bake', nodePath: '/root/NavRegion',
    });
    expect(baked.isError, baked.text).toBe(false);
    await game.call('game_wait', { frames: 5, frameType: 'physics' });
    const navMesh = await evalResult(game, [
      'var region := get_tree().root.get_node("NavRegion") as NavigationRegion3D',
      'var vertices := region.navigation_mesh.get_vertices()',
      'return {"vertices": vertices.size(), "polygons": region.navigation_mesh.get_polygon_count(), "cell_size": region.navigation_mesh.cell_size}',
    ].join('\n')) as {
      vertices: number;
      polygons: number;
      cell_size: number;
    };
    expect(navMesh.vertices).toBeGreaterThan(0);
    expect(navMesh.polygons).toBeGreaterThan(0);
    expect(navMesh.cell_size).toBeCloseTo(0.25);

    const path3d = await game.call('game_navigate_path', {
      start: { x: -4, y: 0.5, z: -4 }, end: { x: 4, y: 0.5, z: 4 }, optimize: true,
    });
    expect(path3d.isError, path3d.text).toBe(false);
    expect(payload(path3d.text)).toMatchObject({ mode: '3d', path: expect.any(Array) });

    await evalResult(game, [
      'var region := NavigationRegion2D.new()',
      'region.name = "NavRegion2D"',
      'var polygon := NavigationPolygon.new()',
      'polygon.vertices = PackedVector2Array([Vector2(-10, -10), Vector2(10, -10), Vector2(10, 10), Vector2(-10, 10)])',
      'polygon.add_polygon(PackedInt32Array([0, 1, 2, 3]))',
      'region.navigation_polygon = polygon',
      'get_tree().root.get_node("Main").add_child(region)',
      'return region.get_path()',
    ].join('\n'));
    await game.call('game_wait', { frames: 3, frameType: 'physics' });
    const path2d = await game.call('game_navigate_path', {
      start: { x: -5, y: -5 }, end: { x: 5, y: 5 }, optimize: false,
    });
    expect(path2d.isError, path2d.text).toBe(false);
    expect(payload(path2d.text)).toMatchObject({ mode: '2d', point_count: expect.any(Number) });
    expect((payload(path2d.text) as { point_count: number }).point_count).toBeGreaterThanOrEqual(2);

    await expect(game.client.callTool({
      name: 'game_navigate_path', arguments: { start: { x: 0, y: 0 } },
    })).rejects.toThrow(/end is required/i);
  });
});
