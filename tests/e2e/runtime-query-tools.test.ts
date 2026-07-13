// @test-kind: e2e
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

async function startedGame(options: { privileged?: boolean } = {}): Promise<E2EServer> {
  server = await startServer({ allowPrivileged: options.privileged });
  const started = await server.call('run_project', { projectPath: server.projectPath });
  expect(started.isError, started.text).toBe(false);
  await server.waitForGameConnection();
  return server;
}

describe('runtime query G+ tools through MCP', () => {
  it('game_get_scene_tree reflects the independently defined fixture and is repeatable', async () => {
    const game = await startedGame();
    const fixture = readFileSync(join(game.projectPath, 'main.tscn'), 'utf8');
    expect(fixture).toContain('[node name="Anchor" type="Node2D" parent="."]');

    const first = await game.call('game_get_scene_tree');
    const second = await game.call('game_get_scene_tree');
    expect(first.isError, first.text).toBe(false);
    expect(second.isError, second.text).toBe(false);
    expect(first.text).toContain('"name": "Main"');
    expect(first.text).toContain('"name": "Anchor"');
    expect(payload(first.text)).toEqual(payload(second.text));
  });

  it('game_get_scene_tree bounds large trees with deterministic pre-order truncation', async () => {
    const game = await startedGame({ privileged: true });
    const created = await game.call('game_eval', {
      code: 'for i in range(20):\n\tvar node = Node.new()\n\tnode.name = "Bounded_%02d" % i\n\tget_tree().root.get_node("Main").add_child(node)\nreturn true',
    });
    expect(created.isError, created.text).toBe(false);

    const first = await game.call('game_get_scene_tree', { maxNodes: 5 });
    const second = await game.call('game_get_scene_tree', { maxNodes: 5 });
    expect(first.isError, first.text).toBe(false);
    expect(payload(first.text)).toEqual(payload(second.text));
    expect(payload(first.text)).toMatchObject({ node_count: 5, max_nodes: 5, truncated: true });
    expect(first.text.length).toBeLessThan(2000);
  });

  it('game_eval executes privileged code and its mutation is observed separately', async () => {
    const game = await startedGame({ privileged: true });
    const evaluated = await game.call('game_eval', {
      code: 'get_tree().root.get_node("Main/Anchor").position = Vector2(12, 34)\nreturn "mutated"',
    });
    expect(evaluated.isError, evaluated.text).toBe(false);
    expect((payload(evaluated.text) as { result: string }).result).toBe('mutated');

    const observed = await game.call('game_get_property', {
      nodePath: '/root/Main/Anchor',
      property: 'position',
    });
    expect(observed.isError, observed.text).toBe(false);
    expect((payload(observed.text) as { value: { x: number; y: number } }).value).toEqual({ x: 12, y: 34 });

    const tree = await game.call('game_get_scene_tree');
    expect(tree.text).not.toContain('@@GDScript');
  });

  it('game_get_property reads typed values and cleanly rejects missing targets', async () => {
    const game = await startedGame({ privileged: true });
    const value = await game.call('game_get_property', {
      nodePath: '/root/Main/Anchor',
      property: 'position',
    });
    expect(value.isError, value.text).toBe(false);
    expect((payload(value.text) as { value: { x: number; y: number } }).value).toEqual({ x: 0, y: 0 });

    const missingNode = await game.call('game_get_property', {
      nodePath: '/root/Main/Missing',
      property: 'position',
    });
    expect(missingNode.isError).toBe(true);
    expect(missingNode.text).toMatch(/node not found/i);

    const missingProperty = await game.call('game_get_property', {
      nodePath: '/root/Main/Anchor',
      property: 'not_a_real_property',
    });
    expect(missingProperty.isError).toBe(true);
    expect(missingProperty.text).toMatch(/property not found/i);
  });

  it('game_wait covers defaults, render/physics clocks, and invalid boundaries', async () => {
    const game = await startedGame({ privileged: true });
    const before = await game.call('game_eval', {
      code: 'return {"render": Engine.get_process_frames(), "physics": Engine.get_physics_frames()}',
    });
    const start = (payload(before.text) as { result: { render: number; physics: number } }).result;

    const defaultWait = await game.call('game_wait');
    expect(defaultWait.isError, defaultWait.text).toBe(false);
    expect(payload(defaultWait.text))
      .toMatchObject({ waited_frames: 1, frame_type: 'render' });

    const physicsWait = await game.call('game_wait', { frames: 2, frameType: 'physics' });
    expect(physicsWait.isError, physicsWait.text).toBe(false);
    expect(payload(physicsWait.text))
      .toMatchObject({ waited_frames: 2, frame_type: 'physics' });

    const after = await game.call('game_eval', {
      code: 'return {"render": Engine.get_process_frames(), "physics": Engine.get_physics_frames()}',
    });
    const end = (payload(after.text) as { result: { render: number; physics: number } }).result;
    expect(end.render).toBeGreaterThan(start.render);
    expect(end.physics - start.physics).toBeGreaterThanOrEqual(2);

    const zero = await game.call('game_wait', { frames: 0 });
    expect(zero.isError).toBe(true);
    expect(zero.text).toMatch(/positive integer/i);
    await expect(game.client.callTool({ name: 'game_wait', arguments: { frames: 1.5 } }))
      .rejects.toThrow(/frames.*integer/i);
  });

  it('game_os_info agrees with an independent engine query', async () => {
    const game = await startedGame({ privileged: true });
    const infoResult = await game.call('game_os_info');
    expect(infoResult.isError, infoResult.text).toBe(false);
    const info = payload(infoResult.text) as { os_name: string; locale: string; processor_count: number };
    expect(info.os_name).not.toBe('');
    expect(info.locale).not.toBe('');
    expect(info.processor_count).toBeGreaterThan(0);

    const observed = await game.call('game_eval', {
      code: 'return {"os_name": OS.get_name(), "locale": OS.get_locale(), "processor_count": OS.get_processor_count()}',
    });
    expect((payload(observed.text) as { result: unknown }).result).toEqual({
      os_name: info.os_name,
      locale: info.locale,
      processor_count: info.processor_count,
    });
  });
});
