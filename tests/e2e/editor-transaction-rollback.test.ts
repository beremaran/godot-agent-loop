// @test-kind: e2e
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertNoLeakedGodotProcesses,
  createTempProject,
  findProcesses,
  killGodotProcesses,
  repoRoot,
  resolveGodotBinary,
  startServer,
  type E2EServer,
} from './helpers/harness.js';
import { e2eHeadless } from './helpers/e2e-headless.js';

const retainedRoots = new Set<string>();

afterEach(async () => {
  for (const root of retainedRoots) {
    await killGodotProcesses(root);
    rmSync(root, { recursive: true, force: true });
  }
  retainedRoots.clear();
});

function installPersistentAddon(projectPath: string): void {
  const addonPath = join(projectPath, 'addons/godot_agent_loop');
  mkdirSync(addonPath, { recursive: true });
  for (const file of ['plugin.gd', 'plugin.cfg', 'README.md', 'LICENSE']) {
    copyFileSync(join(repoRoot, 'addons/godot_agent_loop', file), join(addonPath, file));
  }
  const projectFile = join(projectPath, 'project.godot');
  const source = readFileSync(projectFile, 'utf8').replace(/\n*$/, '\n');
  writeFileSync(projectFile, `${source}\n[editor_plugins]\nenabled=PackedStringArray("res://addons/godot_agent_loop/plugin.cfg")\n`);
}

function startEditor(projectPath: string, extraEnv: Record<string, string>): { child: ChildProcess; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const args = ['--editor', '--path', projectPath];
  if (e2eHeadless) args.unshift('--headless');
  const child = spawn(resolveGodotBinary(), args, {
    env: {
      ...process.env,
      GODOT_MCP_EDITOR_START_PAUSED: 'false',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', data => diagnostics.push(String(data)));
  child.stderr?.on('data', data => diagnostics.push(String(data)));
  return { child, diagnostics };
}

async function waitForDiscovery(projectPath: string, diagnostics: string[]): Promise<void> {
  const record = join(projectPath, '.godot/godot_agent_loop/editor-session.json');
  const deadline = Date.now() + 20_000;
  while (!existsSync(record) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  expect(existsSync(record), diagnostics.join('\n')).toBe(true);
}

async function ensureConnected(server: E2EServer, projectPath: string): Promise<Record<string, any>> {
  const deadline = Date.now() + 20_000;
  let last = await server.call('editor_session', {
    projectPath, action: 'ensure', launchIfNeeded: false, timeoutSeconds: 1,
  });
  while (Date.now() < deadline) {
    if (!last.isError) {
      const parsed = JSON.parse(last.text) as Record<string, any>;
      if (parsed.editor_session?.connected === true) return parsed;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
    last = await server.call('editor_session', {
      projectPath, action: 'ensure', launchIfNeeded: false, timeoutSeconds: 1,
    });
  }
  throw new Error(`Editor never connected: ${last.text}`);
}

async function stopEditor(root: string, projectPath: string, child: ChildProcess): Promise<void> {
  child.kill('SIGTERM');
  const exitDeadline = Date.now() + 10_000;
  while ((await findProcesses(root)).length > 0 && Date.now() < exitDeadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if ((await findProcesses(root)).length > 0) await killGodotProcesses(root);
  await assertNoLeakedGodotProcesses(root);
}

function transactionFailure(text: string): Record<string, any> {
  const message = text.replace(/^editor_transaction failed:\s*/, '').trim();
  return JSON.parse(message);
}

function inspectEditedScene(server: E2EServer, projectPath: string): Promise<any> {
  return server.call('editor_control', { projectPath, action: 'inspect' })
    .then(result => {
      expect(result.isError, result.text).toBe(false);
      return JSON.parse(result.text);
    });
}

describe('editor_transaction post-commit failure rollback', () => {
  it('undoes a committed mutation when the scene save fails for an existing scene', async () => {
    const project = createTempProject();
    retainedRoots.add(project.root);
    installPersistentAddon(project.projectPath);
    const sceneFile = join(project.projectPath, 'main.tscn');
    const before = readFileSync(sceneFile, 'utf8');
    expect(before).toContain('[node name="Anchor"');
    const editor = startEditor(project.projectPath, { GODOT_MCP_FORCE_SAVE_FAILURE: '1' });
    const server = await startServer({ project, preserveProject: true });
    try {
      await waitForDiscovery(project.projectPath, editor.diagnostics);
      await ensureConnected(server, project.projectPath);
      const result = await server.call('editor_transaction', {
        projectPath: project.projectPath, scenePath: 'main.tscn', name: 'Doomed committed edit',
        operations: [{ op: 'add_node', parentPath: '.', nodeType: 'Node2D', nodeName: 'RollbackIntruder' }],
        save: true,
      });
      expect(result.isError, result.text).toBe(true);
      const failure = transactionFailure(result.text);
      expect(failure.error).toBe('scene_save_failed');
      expect(failure.undo_recorded).toBe(true);
      expect(failure.committed_action_undone).toBe(true);
      expect(failure.partial_mutation).toBeUndefined();
      expect(readFileSync(sceneFile, 'utf8')).toBe(before);
      expect(readFileSync(sceneFile, 'utf8')).not.toContain('RollbackIntruder');
      const inspected = await inspectEditedScene(server, project.projectPath);
      expect(inspected.edited_scene).toBe('res://main.tscn');
      expect(inspected.edited_root).toMatchObject({ name: 'Main', type: 'Node2D' });
      const retry = await server.call('editor_transaction', {
        projectPath: project.projectPath, scenePath: 'main.tscn', name: 'Post-rollback retry',
        operations: [{ op: 'add_node', parentPath: '.', nodeType: 'Node2D', nodeName: 'RollbackRetry' }],
        save: false,
      });
      expect(retry.isError, retry.text).toBe(false);
      const undone = await server.call('editor_control', {
        projectPath: project.projectPath, action: 'undo',
      });
      expect(undone.isError, undone.text).toBe(false);
    } finally {
      await server.close().catch(() => undefined);
      await stopEditor(project.root, project.projectPath, editor.child);
    }
  }, 90_000);

  it('undoes a committed mutation and restores the file when the readback fails for an existing scene', async () => {
    const project = createTempProject();
    retainedRoots.add(project.root);
    installPersistentAddon(project.projectPath);
    const sceneFile = join(project.projectPath, 'main.tscn');
    const before = readFileSync(sceneFile, 'utf8');
    expect(before).toContain('[node name="Anchor"');
    const editor = startEditor(project.projectPath, { GODOT_MCP_FORCE_READBACK_FAILURE: '1' });
    const server = await startServer({ project, preserveProject: true });
    try {
      await waitForDiscovery(project.projectPath, editor.diagnostics);
      await ensureConnected(server, project.projectPath);
      const result = await server.call('editor_transaction', {
        projectPath: project.projectPath, scenePath: 'main.tscn', name: 'Doomed committed edit',
        operations: [{ op: 'add_node', parentPath: '.', nodeType: 'Node2D', nodeName: 'RollbackIntruder' }],
        save: true,
      });
      expect(result.isError, result.text).toBe(true);
      const failure = transactionFailure(result.text);
      expect(failure.error).toBe('independent_readback_failed');
      expect(failure.undo_recorded).toBe(true);
      expect(failure.committed_action_undone).toBe(true);
      expect(failure.file_restored).toBe(true);
      expect(failure.partial_mutation).toBeUndefined();
      const after = readFileSync(sceneFile, 'utf8');
      expect(after).not.toContain('RollbackIntruder');
      expect(after).toContain('[node name="Anchor"');
      const inspected = await inspectEditedScene(server, project.projectPath);
      expect(inspected.edited_scene).toBe('res://main.tscn');
      expect(inspected.edited_root).toMatchObject({ name: 'Main', type: 'Node2D' });
    } finally {
      await server.close().catch(() => undefined);
      await stopEditor(project.root, project.projectPath, editor.child);
    }
  }, 90_000);

  it('removes the file and closes the editor scene when a created scene fails to save', async () => {
    const project = createTempProject();
    retainedRoots.add(project.root);
    installPersistentAddon(project.projectPath);
    const createdPath = 'rollback_created.tscn';
    const createdFile = join(project.projectPath, createdPath);
    expect(existsSync(createdFile)).toBe(false);
    const editor = startEditor(project.projectPath, { GODOT_MCP_FORCE_SAVE_FAILURE: '1' });
    const server = await startServer({ project, preserveProject: true });
    try {
      await waitForDiscovery(project.projectPath, editor.diagnostics);
      await ensureConnected(server, project.projectPath);
      const result = await server.call('editor_transaction', {
        projectPath: project.projectPath, scenePath: createdPath, name: 'Doomed creation',
        rootType: 'Node', save: true,
        operations: [{ op: 'add_node', parentPath: '.', nodeType: 'Node', nodeName: 'CreatedChild' }],
      });
      expect(result.isError, result.text).toBe(true);
      const failure = transactionFailure(result.text);
      expect(failure.error).toBe('scene_save_failed');
      expect(failure.scene_created).toBe(true);
      expect(failure.committed_action_undone).toBe(true);
      expect(failure.created_scene_rolled_back).toBe(true);
      expect(failure.scene_closed).toBe(true);
      expect(failure.partial_mutation).toBeUndefined();
      expect(existsSync(createdFile)).toBe(false);
      const inspected = await inspectEditedScene(server, project.projectPath);
      expect(inspected.edited_scene).not.toBe(`res://${createdPath}`);
      expect(inspected.open_scenes).not.toContain(`res://${createdPath}`);
    } finally {
      await server.close().catch(() => undefined);
      await stopEditor(project.root, project.projectPath, editor.child);
    }
  }, 90_000);
});
