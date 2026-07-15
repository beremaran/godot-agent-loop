// @test-kind: e2e
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertNoLeakedGodotProcesses,
  createTempProject,
  killGodotProcesses,
  repoRoot,
  resolveGodotBinary,
  startServer,
} from './helpers/harness.js';

/**
 * Phase 6b full-path crash-recovery coverage: run_project reaches the game by
 * generating override.cfg and copying the runtime scripts, and a SIGKILLed
 * server necessarily leaves those artifacts behind. The next server must reap
 * them on first contact with the project, and a complete run/stop cycle must
 * leave the project tree byte-identical to its pre-launch state.
 */

/** Every file under dir as relative path -> sha256, so trees compare by content. */
function snapshotTree(dir: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const absolute = join(dir, entry);
    if (!statSync(absolute).isFile()) continue;
    snapshot[entry] = createHash('sha256').update(readFileSync(absolute)).digest('hex');
  }
  return snapshot;
}

describe('crash recovery across the full MCP path', () => {
  it('reaps a SIGKILLed run_project installation and restores the tree byte-identically', async () => {
    const project = createTempProject();
    const before = snapshotTree(project.projectPath);

    // First server: inject and connect, then die without any chance to clean up.
    const first = await startServer({ project });
    const run = await first.call('run_project', { projectPath: first.projectPath });
    expect(run.isError, run.text).toBe(false);
    await first.waitForGameConnection();
    process.kill(first.pid, 'SIGKILL');
    await first.client.close().catch(() => undefined);
    // The orphaned game outlives its server; reap it the way a user would.
    await killGodotProcesses(project.root);
    await assertNoLeakedGodotProcesses(project.root);

    // SIGKILL provably left the injection artifacts in the user's tree.
    expect(existsSync(join(project.projectPath, 'override.cfg'))).toBe(true);
    expect(existsSync(join(project.projectPath, 'mcp_interaction_server.gd'))).toBe(true);
    expect(existsSync(join(project.projectPath, 'mcp_runtime'))).toBe(true);
    // project.godot was never part of the injection.
    expect(readFileSync(join(project.projectPath, 'project.godot'), 'utf8'))
      .not.toContain('McpInteractionServer');

    // Second server: first contact reaps the stale installation, and a full
    // run/stop cycle owns its own artifacts end to end.
    const second = await startServer({ project, extraEnv: { DEBUG: 'true' } });
    try {
      const rerun = await second.call('run_project', { projectPath: second.projectPath });
      expect(rerun.isError, rerun.text).toBe(false);
      await second.waitForGameConnection();
      expect(second.serverLogs.join('\n')).toContain('Reaped stale interaction server artifacts');

      const stopped = await second.call('stop_project');
      expect(stopped.isError, stopped.text).toBe(false);
      await assertNoLeakedGodotProcesses(project.root);

      expect(snapshotTree(project.projectPath)).toEqual(before);
    } finally {
      await second.client.close().catch(() => undefined);
      await assertNoLeakedGodotProcesses(project.root);
      rmSync(project.root, { recursive: true, force: true });
    }
  });

  it('reclaims a SIGKILLed transient editor bridge on the next launch', async () => {
    const project = createTempProject();
    const projectFile = join(project.projectPath, 'project.godot');
    const normalizer = join(project.projectPath, 'normalize_project.gd');
    copyFileSync(join(repoRoot, 'tests/godot/normalize_project.gd'), normalizer);
    execFileSync(resolveGodotBinary(), [
      '--headless', '--path', project.projectPath, '--script', normalizer,
    ]);
    rmSync(normalizer);
    const projectBefore = readFileSync(projectFile, 'utf8');
    const transientAddon = join(project.projectPath, 'addons/godot_agent_loop_transient');

    const first = await startServer({ project, preserveProject: true });
    const firstLaunch = await first.call('launch_editor', { projectPath: project.projectPath });
    expect(firstLaunch.isError, firstLaunch.text).toBe(false);
    expect(JSON.parse(firstLaunch.text)).toMatchObject({
      editor_session: { plugin_distribution: 'transient', plugin_owned: true },
    });
    process.kill(first.pid, 'SIGKILL');
    await first.client.close().catch(() => undefined);
    await killGodotProcesses(project.root);
    await assertNoLeakedGodotProcesses(project.root);
    expect(existsSync(transientAddon)).toBe(true);
    expect(readFileSync(projectFile, 'utf8')).toContain('godot_agent_loop_transient');

    const second = await startServer({ project, preserveProject: true });
    try {
      const secondLaunch = await second.call('launch_editor', { projectPath: project.projectPath });
      expect(secondLaunch.isError, secondLaunch.text).toBe(false);
      expect(JSON.parse(secondLaunch.text)).toMatchObject({
        editor_session: { plugin_distribution: 'transient', plugin_owned: true },
      });
    } finally {
      await second.client.close().catch(() => undefined);
      await killGodotProcesses(project.root);
      await assertNoLeakedGodotProcesses(project.root);
    }

    expect(existsSync(transientAddon)).toBe(false);
    expect(readFileSync(projectFile, 'utf8')).toBe(projectBefore);
    rmSync(project.root, { recursive: true, force: true });
  });
});
