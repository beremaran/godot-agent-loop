// @test-kind: e2e
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type E2EServer } from './helpers/harness.js';

/**
 * Full-path E2E coverage for the runtime inspection, mutation, and node
 * lifecycle tools. Every mutation is confirmed by a *separate* observation
 * (a follow-up query, a group tag applied by fixture code, or a scene-tree
 * read), never by the mutating command's own echoed response.
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

/** Read engine state without going through the tool under test. */
async function engineEval(game: E2EServer, code: string): Promise<unknown> {
  const result = await game.call('game_eval', { code });
  expect(result.isError, result.text).toBe(false);
  return (payload(result.text) as { result: unknown }).result;
}

describe('runtime mutation tools through MCP', () => {
  it('game_set_property writes typed values, honours typeHint, and is denied without privilege', async () => {
    const game = await startedGame({ privileged: true });

    const set = await game.call('game_set_property', {
      nodePath: '/root/Main/Anchor', property: 'position', value: { x: 21, y: 43 },
    });
    expect(set.isError, set.text).toBe(false);

    // Independent observation: a separate read command sees the new value.
    const read = await game.call('game_get_property', { nodePath: '/root/Main/Anchor', property: 'position' });
    expect((payload(read.text) as { value: unknown }).value).toEqual({ x: 21, y: 43 });

    // A scalar and a bool property exercise other codec families.
    expect((await game.call('game_set_property', {
      nodePath: '/root/Main/Anchor', property: 'rotation', value: 1.5,
    })).isError).toBe(false);
    expect((await game.call('game_set_property', {
      nodePath: '/root/Main/Anchor', property: 'visible', value: false,
    })).isError).toBe(false);
    expect(await engineEval(game, 'var a = get_node("/root/Main/Anchor")\nreturn [snappedf(a.rotation, 0.001), a.visible]'))
      .toEqual([1.5, false]);

    // An explicit typeHint drives the codec instead of the property's declared type.
    const hinted = await game.call('game_set_property', {
      nodePath: '/root/Main/VisualTarget', property: 'position', value: { x: 1, y: 2, z: 3 }, typeHint: 'Vector3',
    });
    expect(hinted.isError, hinted.text).toBe(false);
    expect(await engineEval(game, 'var v = get_node("/root/Main/VisualTarget").position\nreturn [v.x, v.y, v.z]'))
      .toEqual([1, 2, 3]);

    const missingNode = await game.call('game_set_property', {
      nodePath: '/root/Main/Ghost', property: 'position', value: { x: 0, y: 0 },
    });
    expect(missingNode.isError).toBe(true);
    expect(missingNode.text).toMatch(/node not found/i);
  });

  it('game_set_property and game_call_method are refused when privileged commands are off', async () => {
    const game = await startedGame(); // no GODOT_MCP_ALLOW_PRIVILEGED_COMMANDS

    const denied = await game.call('game_set_property', {
      nodePath: '/root/Main/Anchor', property: 'position', value: { x: 5, y: 5 },
    });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/privileg|denied|not allowed/i);

    const deniedCall = await game.call('game_call_method', { nodePath: '/root/Main', method: 'observe_value', args: [1] });
    expect(deniedCall.isError).toBe(true);
    expect(deniedCall.text).toMatch(/privileg|denied|not allowed/i);

    // Denial must be a policy refusal, not a silent no-op. game_get_property is
    // itself privileged, so the unchanged value is observed through the
    // unprivileged node-info command instead.
    const info = await game.call('game_get_node_info', { nodePath: '/root/Main/Anchor' });
    expect(info.isError, info.text).toBe(false);
    const position = (payload(info.text) as { properties: { name: string; value: unknown }[] })
      .properties.find(property => property.name === 'position');
    expect(position?.value).toEqual({ x: 0, y: 0 });
  });

  it('game_call_method invokes fixture methods with arguments and reports missing methods', async () => {
    const game = await startedGame({ privileged: true });

    // observe_value tags the node with a group naming its arguments, so the call
    // is observable without trusting the command's own return value.
    const called = await game.call('game_call_method', {
      nodePath: '/root/Main', method: 'observe_value', args: [7, '-suffix'],
    });
    expect(called.isError, called.text).toBe(false);

    const grouped = await game.call('game_get_nodes_in_group', { group: 'signal-value-7-suffix' });
    expect(grouped.isError, grouped.text).toBe(false);
    expect(grouped.text).toContain('/root/Main');

    // A method with a return value round-trips through the variant codec.
    const returned = await game.call('game_call_method', { nodePath: '/root/Main', method: 'get_class' });
    expect((payload(returned.text) as { result: unknown }).result).toBe('Node2D');

    const missing = await game.call('game_call_method', { nodePath: '/root/Main', method: 'no_such_method' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/method not found/i);
  });

  it('game_get_node_info reports class, children, signals, and methods', async () => {
    const game = await startedGame();

    const result = await game.call('game_get_node_info', { nodePath: '/root/Main', detail: 'full' });
    expect(result.isError, result.text).toBe(false);
    const info = payload(result.text) as {
      class: string; name: string; path: string;
      properties: { name: string }[]; signals: unknown[]; methods: unknown[];
      children: { name: string; type: string }[];
    };
    expect(info.class).toBe('Node2D');
    expect(info.name).toBe('Main');
    expect(info.path).toBe('/root/Main');
    expect(info.children.map(child => child.name)).toEqual(expect.arrayContaining(['Anchor', 'Tiles', 'VisualTarget']));
    expect(info.properties.map(property => property.name)).toContain('position');
    expect(JSON.stringify(info.signals)).toContain('e2e_event');
    expect(JSON.stringify(info.methods)).toContain('observe_value');

    const compactResult = await game.call('game_get_node_info', {
      nodePath: '/root/Main', detail: 'compact', propertyNames: ['position'],
    });
    expect(compactResult.isError, compactResult.text).toBe(false);
    const compact = payload(compactResult.text) as {
      detail: string; properties: { name: string }[]; signals: unknown[]; methods: unknown[];
    };
    expect(compact.detail).toBe('compact');
    expect(compact.properties.map(property => property.name)).toEqual(['position']);
    expect(compact.signals).toEqual([]);
    expect(compact.methods).toEqual([]);

    const missing = await game.call('game_get_node_info', { nodePath: '/root/Main/Ghost' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/node not found/i);
  });

  it('game_spawn_node creates a configured node and game_remove_node deletes it', async () => {
    // The tools under test are unprivileged; the *observers* (eval, get_property)
    // are privileged, so the session opts in to read engine state back.
    const game = await startedGame({ privileged: true });

    const spawned = await game.call('game_spawn_node', {
      type: 'Node2D', name: 'Spawned', parentPath: '/root/Main', properties: { position: { x: 8, y: 9 } },
    });
    expect(spawned.isError, spawned.text).toBe(false);

    // Independent observation: the node exists in the tree with the requested property.
    const tree = await game.call('game_get_scene_tree');
    expect(tree.text).toContain('"name": "Spawned"');
    const position = await game.call('game_get_property', { nodePath: '/root/Main/Spawned', property: 'position' });
    expect((payload(position.text) as { value: unknown }).value).toEqual({ x: 8, y: 9 });

    const removed = await game.call('game_remove_node', { nodePath: '/root/Main/Spawned' });
    expect(removed.isError, removed.text).toBe(false);

    // queue_free resolves at frame end, so settle before observing the deletion.
    await game.call('game_wait', { frames: 2 });
    expect(await engineEval(game, 'return get_tree().root.get_node_or_null("/root/Main/Spawned") != null')).toBe(false);

    const missing = await game.call('game_remove_node', { nodePath: '/root/Main/Spawned' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/node not found/i);

    const badType = await game.call('game_spawn_node', { type: 'NotARealClass', name: 'Bogus' });
    expect(badType.isError).toBe(true);
  });

  it('game_instantiate_scene adds a saved scene into the running tree', async () => {
    const game = await startedGame({ privileged: true });

    // Author the scene through the headless tools, then instantiate it at runtime.
    const created = await game.call('create_scene', {
      projectPath: game.projectPath, scenePath: 'res://spawnable.tscn', rootNodeType: 'Node2D',
    });
    expect(created.isError, created.text).toBe(false);
    const added = await game.call('add_node', {
      projectPath: game.projectPath, scenePath: 'res://spawnable.tscn',
      parentNodePath: 'root', nodeType: 'Sprite2D', nodeName: 'Badge',
    });
    expect(added.isError, added.text).toBe(false);

    const instantiated = await game.call('game_instantiate_scene', {
      scenePath: 'res://spawnable.tscn', parentPath: '/root/Main',
    });
    expect(instantiated.isError, instantiated.text).toBe(false);
    const instance = payload(instantiated.text) as { instance_path: string };

    // Independent observation: the instance and its child exist in the live tree.
    expect(await engineEval(game, `return get_node("${instance.instance_path}/Badge").get_class()`)).toBe('Sprite2D');

    const missing = await game.call('game_instantiate_scene', { scenePath: 'res://absent.tscn' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/failed to load scene|resource_not_found/i);
  });

  it('game_change_scene swaps the running scene', async () => {
    const game = await startedGame({ privileged: true });

    const created = await game.call('create_scene', {
      projectPath: game.projectPath, scenePath: 'res://second.tscn', rootNodeType: 'Node3D',
    });
    expect(created.isError, created.text).toBe(false);

    const changed = await game.call('game_change_scene', { scenePath: 'res://second.tscn' });
    expect(changed.isError, changed.text).toBe(false);

    // change_scene_to_file is deferred to the end of the frame.
    await game.call('game_wait', { frames: 2 });
    expect(await engineEval(game, 'return get_tree().current_scene.scene_file_path')).toBe('res://second.tscn');
    expect(await engineEval(game, 'return get_tree().current_scene.get_class()')).toBe('Node3D');

    const missing = await game.call('game_change_scene', { scenePath: 'res://nope.tscn' });
    expect(missing.isError).toBe(true);
  });

  it('game_reparent_node moves a node and can preserve its global transform', async () => {
    const game = await startedGame({ privileged: true });

    await game.call('game_set_property', { nodePath: '/root/Main/Anchor', property: 'position', value: { x: 100, y: 0 } });
    const spawned = await game.call('game_spawn_node', {
      type: 'Node2D', name: 'Rider', parentPath: '/root/Main', properties: { position: { x: 10, y: 20 } },
    });
    expect(spawned.isError, spawned.text).toBe(false);

    const reparented = await game.call('game_reparent_node', {
      nodePath: '/root/Main/Rider', newParentPath: '/root/Main/Anchor', keepGlobalTransform: true,
    });
    expect(reparented.isError, reparented.text).toBe(false);

    // Independent observation: new parent, and the global position is unchanged
    // while the local position was rebased by the parent's offset.
    const observed = await engineEval(game, [
      'var rider = get_node("/root/Main/Anchor/Rider")',
      'return {',
      '\t"parent": str(rider.get_parent().get_path()),',
      '\t"global": [rider.global_position.x, rider.global_position.y],',
      '\t"local": [rider.position.x, rider.position.y],',
      '}',
    ].join('\n')) as { parent: string; global: number[]; local: number[] };
    expect(observed.parent).toBe('/root/Main/Anchor');
    expect(observed.global).toEqual([10, 20]);
    expect(observed.local).toEqual([-90, 20]);

    const missing = await game.call('game_reparent_node', {
      nodePath: '/root/Main/Ghost', newParentPath: '/root/Main',
    });
    expect(missing.isError).toBe(true);
  });

  it('game_manage_group add/remove/get_groups drives real group membership', async () => {
    const game = await startedGame({ privileged: true });

    const added = await game.call('game_manage_group', {
      nodePath: '/root/Main/Anchor', action: 'add', group: 'squad',
    });
    expect(added.isError, added.text).toBe(false);

    // Independent observation: a different command resolves the group.
    const members = await game.call('game_get_nodes_in_group', { group: 'squad' });
    expect(members.text).toContain('/root/Main/Anchor');

    const groups = await game.call('game_manage_group', { nodePath: '/root/Main/Anchor', action: 'get_groups' });
    expect(groups.isError, groups.text).toBe(false);
    expect(groups.text).toContain('squad');

    const removed = await game.call('game_manage_group', {
      nodePath: '/root/Main/Anchor', action: 'remove', group: 'squad',
    });
    expect(removed.isError, removed.text).toBe(false);
    expect(await engineEval(game, 'return get_node("/root/Main/Anchor").is_in_group("squad")')).toBe(false);

    const empty = await game.call('game_get_nodes_in_group', { group: 'squad' });
    expect(empty.isError, empty.text).toBe(false);
    expect(empty.text).not.toContain('/root/Main/Anchor');
  });

  it('game_find_nodes_by_class searches the tree and honours rootPath', async () => {
    const game = await startedGame();

    const found = await game.call('game_find_nodes_by_class', { className: 'MeshInstance3D' });
    expect(found.isError, found.text).toBe(false);
    expect(found.text).toContain('/root/Main/VisualTarget');

    const scoped = await game.call('game_find_nodes_by_class', { className: 'StaticBody2D', rootPath: '/root/Main/Physics2D' });
    expect(scoped.isError, scoped.text).toBe(false);
    expect(scoped.text).toContain('/root/Main/Physics2D/Wall');

    // A class present elsewhere is excluded by a narrower root.
    const excluded = await game.call('game_find_nodes_by_class', { className: 'MeshInstance3D', rootPath: '/root/Main/Physics2D' });
    expect(excluded.isError, excluded.text).toBe(false);
    expect(excluded.text).not.toContain('VisualTarget');

    const none = await game.call('game_find_nodes_by_class', { className: 'Camera3D' });
    expect(none.isError, none.text).toBe(false);
    expect(none.text).not.toContain('/root/Main/');
  });

  it('game_create_timer adds a live Timer node with the requested configuration', async () => {
    const game = await startedGame({ privileged: true });

    const created = await game.call('game_create_timer', {
      parentPath: '/root/Main', waitTime: 0.05, oneShot: true, autostart: true, name: 'Countdown',
    });
    expect(created.isError, created.text).toBe(false);
    expect(payload(created.text)).toMatchObject({
      path: '/root/Main/Countdown', name: 'Countdown', wait_time: 0.05, one_shot: true, autostart: true,
    });

    // Independent observation: the Timer exists, is running, and actually fires.
    const running = await engineEval(game, [
      'var timer = get_node("/root/Main/Countdown")',
      'return {"class": timer.get_class(), "stopped": timer.is_stopped(), "one_shot": timer.one_shot}',
    ].join('\n')) as { class: string; stopped: boolean; one_shot: boolean };
    expect(running.class).toBe('Timer');
    expect(running.stopped).toBe(false);
    expect(running.one_shot).toBe(true);

    const fired = await game.call('game_await_signal', {
      nodePath: '/root/Main/Countdown', signalName: 'timeout', timeout: 5,
    });
    expect(fired.isError, fired.text).toBe(false);

    const badParent = await game.call('game_create_timer', { parentPath: '/root/Nowhere' });
    expect(badParent.isError).toBe(true);
    expect(badParent.text).toMatch(/parent node not found/i);
  });

  it('game_serialize_state saves a subtree and restores it after a mutation', async () => {
    const game = await startedGame({ privileged: true });

    await game.call('game_set_property', { nodePath: '/root/Main/Anchor', property: 'position', value: { x: 11, y: 22 } });

    const saved = await game.call('game_serialize_state', {
      nodePath: '/root/Main/Anchor', action: 'save', maxDepth: 1,
    });
    expect(saved.isError, saved.text).toBe(false);
    const snapshot = payload(saved.text) as { state: { name: string; class: string; properties: Record<string, unknown> } };
    expect(snapshot.state.name).toBe('Anchor');
    expect(snapshot.state.class).toBe('Node2D');
    expect(snapshot.state.properties.position).toEqual({ x: 11, y: 22 });

    // Move the node away, then restore the snapshot through the load action.
    await game.call('game_set_property', { nodePath: '/root/Main/Anchor', property: 'position', value: { x: 999, y: 999 } });
    const loaded = await game.call('game_serialize_state', {
      nodePath: '/root/Main/Anchor', action: 'load', data: snapshot.state,
    });
    expect(loaded.isError, loaded.text).toBe(false);
    expect((payload(loaded.text) as { restored_count: number }).restored_count).toBeGreaterThan(0);

    // Independent observation: the engine reports the restored value.
    expect(await engineEval(game, 'var p = get_node("/root/Main/Anchor").position\nreturn [p.x, p.y]')).toEqual([11, 22]);

    const noData = await game.call('game_serialize_state', { nodePath: '/root/Main', action: 'load' });
    expect(noData.isError).toBe(true);
    expect(noData.text).toMatch(/data is required/i);

    const missing = await game.call('game_serialize_state', { nodePath: '/root/Ghost', action: 'save' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/node not found/i);
  });

  it('game_script attaches, reads back, and detaches a runtime script', async () => {
    const game = await startedGame({ privileged: true });

    const bare = await game.call('game_script', { nodePath: '/root/Main/Anchor', action: 'get_source' });
    expect(bare.isError, bare.text).toBe(false);
    expect(payload(bare.text)).toMatchObject({ has_script: false });

    const source = 'extends Node2D\n\n\nfunc _ready() -> void:\n\tadd_to_group("scripted")\n\n\nfunc doubled(value: int) -> int:\n\treturn value * 2\n';
    const attached = await game.call('game_script', { nodePath: '/root/Main/Anchor', action: 'attach', source });
    expect(attached.isError, attached.text).toBe(false);

    // Independent observation: the attached script's method is callable on the node.
    const called = await game.call('game_call_method', {
      nodePath: '/root/Main/Anchor', method: 'doubled', args: [21],
    });
    expect((payload(called.text) as { result: unknown }).result).toBe(42);

    const read = await game.call('game_script', { nodePath: '/root/Main/Anchor', action: 'get_source' });
    expect(payload(read.text)).toMatchObject({ has_script: true });
    expect((payload(read.text) as { source: string }).source).toContain('func doubled');

    const detached = await game.call('game_script', { nodePath: '/root/Main/Anchor', action: 'detach' });
    expect(detached.isError, detached.text).toBe(false);
    expect(await engineEval(game, 'return get_node("/root/Main/Anchor").get_script() == null')).toBe(true);

    const broken = await game.call('game_script', {
      nodePath: '/root/Main/Anchor', action: 'attach', source: 'extends Node2D\nfunc broken(:\n',
    });
    expect(broken.isError).toBe(true);
    expect(broken.text).toMatch(/compile error/i);

    // Regression: a parse error must not take the game down with it. Launching the
    // game with `-d` used to break into Godot's interactive stdout debugger here,
    // freezing the main loop so that every later command timed out.
    const survived = await game.call('game_get_scene_tree');
    expect(survived.isError, `the game must survive a compile error: ${survived.text}`).toBe(false);
    expect(survived.text).toContain('"name": "Main"');
    expect(await engineEval(game, 'return get_node("/root/Main/Anchor").get_script() == null')).toBe(true);

    const noSource = await game.call('game_script', { nodePath: '/root/Main/Anchor', action: 'attach' });
    expect(noSource.isError).toBe(true);
    expect(noSource.text).toMatch(/source is required/i);
  });

  it('game_script is denied without privileged commands enabled', async () => {
    const game = await startedGame();
    const denied = await game.call('game_script', {
      nodePath: '/root/Main/Anchor', action: 'attach', source: 'extends Node2D\n',
    });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/privileg|denied|not allowed/i);
  });
});
