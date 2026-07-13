// @test-kind: e2e
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type E2EServer } from './helpers/harness.js';

/**
 * Evidence for the `reachable` bucket of docs/coverage/engine-surface.md.
 *
 * That report asserts that ~660 engine classes we ship no named tool for are
 * still drivable, generically, through `game_eval` and `add_node`. An assertion
 * like that is worthless unmeasured, so this suite samples the bucket and drives
 * the sample end to end through the real MCP path. It does not prove every
 * class works; it proves the claim is not fiction, and it fails loudly if a
 * Godot release breaks generic reach.
 */

interface SurfaceRow {
  readonly name: string;
  readonly bucket: string;
  readonly instantiable: boolean;
  readonly is_node: boolean;
}

const surface = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../docs/coverage/engine-surface.json', import.meta.url)), 'utf8'),
) as { readonly classes: readonly SurfaceRow[] };

/**
 * A deterministic spread across the bucket rather than a random draw: sorted by
 * name and strided, so the sample is stable across runs and reviewable in a
 * diff, while still touching classes nobody hand-picked to be easy.
 */
function sample(rows: readonly SurfaceRow[], size: number): readonly SurfaceRow[] {
  const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name));
  const stride = Math.max(1, Math.floor(sorted.length / size));
  return sorted.filter((_, index) => index % stride === 0).slice(0, size);
}

const reachable = surface.classes.filter(row => row.bucket === 'reachable' && row.instantiable);
const nodes = sample(reachable.filter(row => row.is_node), 20);
const nonNodes = sample(reachable.filter(row => !row.is_node), 20);

let server: E2EServer | null = null;

afterEach(async () => {
  if (server) {
    const active = server;
    server = null;
    await active.close();
  }
});

async function startedGame(): Promise<E2EServer> {
  server = await startServer({ allowPrivileged: true });
  const started = await server.call('run_project', { projectPath: server.projectPath });
  expect(started.isError, started.text).toBe(false);
  await server.waitForGameConnection();
  return server;
}

async function engineEval(game: E2EServer, code: string): Promise<unknown> {
  const result = await game.call('game_eval', { code });
  expect(result.isError, result.text).toBe(false);
  return (JSON.parse(result.text) as { result: unknown }).result;
}

describe('generic engine reach for untooled classes', () => {
  it('constructs a sample of untooled non-Node classes through game_eval', async () => {
    const game = await startedGame();
    const unreached: string[] = [];

    for (const row of nonNodes) {
      // Report the class name the engine itself gives the instance, so a silent
      // null or a wrong type cannot pass as success.
      const reported = await engineEval(game, [
        `var instance = ClassDB.instantiate("${row.name}")`,
        'if instance == null:',
        '\treturn "<null>"',
        'return instance.get_class()',
      ].join('\n'));
      if (reported !== row.name) unreached.push(`${row.name} -> ${String(reported)}`);
    }

    expect(unreached, `game_eval could not construct: ${unreached.join(', ')}`).toEqual([]);
    expect(nonNodes.length).toBeGreaterThan(10);
  });

  it('adds a sample of untooled Node classes to the live tree and finds them again', async () => {
    const game = await startedGame();
    const unreached: string[] = [];

    for (const row of nodes) {
      await engineEval(game, [
        `var node = ClassDB.instantiate("${row.name}")`,
        'if node == null:',
        '\treturn false',
        `node.name = "reach_${row.name}"`,
        'get_tree().root.add_child(node)',
        'return true',
      ].join('\n'));

      // Independent observation: read the node back through the scene-tree tool
      // rather than trusting the eval that created it.
      const tree = await game.call('game_get_scene_tree', {});
      expect(tree.isError, tree.text).toBe(false);
      if (!tree.text.includes(`reach_${row.name}`)) unreached.push(row.name);
    }

    expect(unreached, `nodes never appeared in the scene tree: ${unreached.join(', ')}`).toEqual([]);
    expect(nodes.length).toBeGreaterThan(10);
  });
});
