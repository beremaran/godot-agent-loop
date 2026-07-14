// @test-kind: e2e
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempProject, repoRoot, resolveGodotBinary, startServer, type E2EServer } from './helpers/harness.js';

const execFileAsync = promisify(execFile);
let server: E2EServer | null = null;
let preservedRoot: string | null = null;

afterEach(async () => {
  if (server) {
    const active = server;
    server = null;
    await execFileAsync('pkill', ['-f', active.projectPath]).catch(() => undefined);
    await active.close();
  }
  if (preservedRoot) {
    rmSync(preservedRoot, { recursive: true, force: true });
    preservedRoot = null;
  }
});

async function waitForEditor(serverUnderTest: E2EServer): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  let result = await serverUnderTest.call('editor_control', {
    projectPath: serverUnderTest.projectPath, action: 'inspect',
  });
  while (result.isError && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
    result = await serverUnderTest.call('editor_control', {
      projectPath: serverUnderTest.projectPath, action: 'inspect',
    });
  }
  expect(result.isError, result.text).toBe(false);
  return JSON.parse(result.text) as Record<string, unknown>;
}

describe('AssetLib addon package lifecycle', () => {
  it('installs, connects, pauses, restarts, disables, and uninstalls without residue', async () => {
    const project = createTempProject();
    preservedRoot = project.root;
    const projectFile = join(project.projectPath, 'project.godot');
    // Establish the engine's own normalized baseline before measuring addon
    // state; otherwise opening a 4.4 fixture in 4.7 legitimately rewrites
    // unrelated compatibility settings.
    const normalizer = join(project.projectPath, 'normalize_project.gd');
    copyFileSync(join(repoRoot, 'tests/godot/normalize_project.gd'), normalizer);
    const normalization = spawnSync(resolveGodotBinary(), [
      '--headless', '--path', project.projectPath, '--script', normalizer,
    ], { encoding: 'utf8' });
    const normalizationOutput = `${normalization.stdout}\n${normalization.stderr}`;
    expect(normalization.status, normalizationOutput).toBe(0);
    expect(normalizationOutput).not.toMatch(/SCRIPT ERROR|\bERROR:|WARNING:/);
    rmSync(normalizer);
    const projectBefore = readFileSync(projectFile, 'utf8');
    const archive = join(project.root, 'godot-agent-loop-bridge.zip');
    execFileSync(process.execPath, [join(repoRoot, 'scripts/build-assetlib-archive.js'), archive]);
    execFileSync('unzip', ['-q', archive, '-d', project.projectPath]);
    const persistentAddon = join(project.projectPath, 'addons/godot_agent_loop');
    const transientAddon = join(project.projectPath, 'addons/godot_agent_loop_transient');
    expect(existsSync(join(persistentAddon, 'plugin.cfg'))).toBe(true);

    server = await startServer({
      project,
      preserveProject: true,
      extraEnv: { GODOT_MCP_EDITOR_START_PAUSED: 'true' },
    });
    const firstLaunch = await server.call('launch_editor', { projectPath: project.projectPath });
    expect(firstLaunch.isError, firstLaunch.text).toBe(false);
    expect(JSON.parse(firstLaunch.text)).toMatchObject({
      plugin_distribution: 'persistent', plugin_owned: false, editor_protocol_version: '1',
    });
    expect(await waitForEditor(server)).toMatchObject({
      authenticated: true, driver_paused: true, addon_version: '1.0.0', protocol_version: '1',
    });
    const refused = await server.call('add_node', {
      projectPath: project.projectPath, scenePath: 'main.tscn',
      parentNodePath: 'root', nodeType: 'Node2D', nodeName: 'MustNotPersist',
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/mutation refused.*paused/is);

    await execFileAsync('pkill', ['-f', project.projectPath]).catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 500));
    const secondLaunch = await server.call('launch_editor', { projectPath: project.projectPath });
    expect(secondLaunch.isError, secondLaunch.text).toBe(false);
    expect(JSON.parse(secondLaunch.text)).toMatchObject({
      plugin_distribution: 'persistent', plugin_owned: false,
    });
    expect(await waitForEditor(server)).toMatchObject({ authenticated: true, driver_paused: true });

    await execFileAsync('pkill', ['-f', project.projectPath]).catch(() => undefined);
    const active = server;
    server = null;
    await active.close();

    expect(readFileSync(projectFile, 'utf8')).toBe(projectBefore);
    expect(existsSync(transientAddon)).toBe(false);
    expect(existsSync(persistentAddon)).toBe(true);
    rmSync(persistentAddon, { recursive: true, force: true });
    expect(existsSync(persistentAddon)).toBe(false);
    expect(readFileSync(projectFile, 'utf8')).toBe(projectBefore);
  });
});
