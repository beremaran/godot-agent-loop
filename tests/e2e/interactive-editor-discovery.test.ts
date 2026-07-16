// @test-kind: e2e
import { spawn, type ChildProcess } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
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

function startNormalEditor(projectPath: string): { child: ChildProcess; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const child = spawn(resolveGodotBinary(), ['--editor', '--path', projectPath], {
    env: { ...process.env, GODOT_MCP_EDITOR_START_PAUSED: 'false' },
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

async function stopNormalEditors(root: string, projectPaths: string[], children: ChildProcess[]): Promise<void> {
  for (const child of children) child.kill('SIGTERM');
  const exitDeadline = Date.now() + 10_000;
  while ((await findProcesses(root)).length > 0 && Date.now() < exitDeadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if ((await findProcesses(root)).length > 0) await killGodotProcesses(root);
  await assertNoLeakedGodotProcesses(root);
  const deadline = Date.now() + 3_000;
  while (projectPaths.some(projectPath => existsSync(join(
    projectPath, '.godot/godot_agent_loop/editor-session.json',
  ))) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  for (const projectPath of projectPaths) {
    expect(existsSync(join(projectPath, '.godot/godot_agent_loop/editor-session.json')),
      'clean editor exit left its discovery record').toBe(false);
  }
}

describe('persistent editor discovery through the complete MCP path', () => {
  it('attaches Godot-first, survives an MCP restart, acknowledges fallback sync, and preserves an unsaved conflict', async () => {
    const project = createTempProject();
    retainedRoots.add(project.root);
    installPersistentAddon(project.projectPath);
    const editor = startNormalEditor(project.projectPath);
    await waitForDiscovery(project.projectPath, editor.diagnostics);

    let first: E2EServer | null = await startServer({ project, preserveProject: true });
    let second: E2EServer | null = null;
    try {
      const attached = await ensureConnected(first, project.projectPath);
      expect(attached).toMatchObject({
        editor_session: { connected: true, reused: true, spawned: false, plugin_distribution: 'persistent' },
      });
      const authored = await first.call('editor_transaction', {
        projectPath: project.projectPath, scenePath: 'main.tscn', name: 'Godot-first visible edit',
        operations: [{ op: 'add_node', parentPath: '.', nodeType: 'Node2D', nodeName: 'GodotFirst' }],
        focusPath: 'GodotFirst', save: true,
      });
      expect(authored.isError, authored.text).toBe(false);
      expect(JSON.parse(authored.text)).toMatchObject({
        backend: 'editor', sync_status: 'acknowledged', observed_target_state: { independently_reopened: true },
      });

      await first.client.close();
      first = null;
      await new Promise(resolve => setTimeout(resolve, 300));
      expect((await findProcesses(project.projectPath)).some(line => /(?:^|\s)--editor(?:\s|$)/.test(line))).toBe(true);

      second = await startServer({ project, preserveProject: true });
      const reattached = await ensureConnected(second, project.projectPath);
      expect(reattached).toMatchObject({ editor_session: { connected: true, reused: true, spawned: false } });
      const replayed = await second.call('editor_control', {
        projectPath: project.projectPath, action: 'inspect',
      });
      const replayedActivity = (JSON.parse(replayed.text) as {
        activity: { event_id?: number; tool?: string; command?: string }[];
      }).activity;
      expect(replayedActivity.some(event => event.tool === 'editor_transaction'
        || event.command === 'editor_transaction')).toBe(true);
      const eventIds = replayedActivity.map(event => event.event_id).filter(Number.isInteger);
      expect(new Set(eventIds).size).toBe(eventIds.length);

      const script = `${readFileSync(join(project.projectPath, 'main.gd'), 'utf8')}\n# externally synchronized\n`;
      const fallback = await second.call('write_file', {
        projectPath: project.projectPath, filePath: 'main.gd', content: script,
      });
      expect(fallback.isError, fallback.text).toBe(false);
      expect((fallback.raw as { structuredContent?: unknown }).structuredContent).toMatchObject({
        meta: { backend: 'file-backed', synchronization: 'acknowledged' },
      });

      const opened = await second.call('editor_control', {
        projectPath: project.projectPath, action: 'open_scene', scenePath: 'main.tscn',
      });
      expect(opened.isError, opened.text).toBe(false);
      const dirty = await second.call('editor_control', {
        projectPath: project.projectPath, action: 'set_property', nodePath: '.', property: 'name', value: 'UnsavedHumanState',
      });
      expect(dirty.isError, dirty.text).toBe(false);
      const diskScene = readFileSync(join(project.projectPath, 'main.tscn'), 'utf8');
      const conflict = await second.call('write_file', {
        projectPath: project.projectPath, filePath: 'main.tscn', content: diskScene,
      });
      expect(conflict.isError, conflict.text).toBe(false);
      expect((conflict.raw as { structuredContent?: unknown }).structuredContent).toMatchObject({
        meta: {
          synchronization: 'conflict',
          synchronizationEvidence: {
            fallback_reason: expect.stringMatching(/unsaved human changes/i),
          },
        },
      });
      const inspected = await second.call('editor_control', {
        projectPath: project.projectPath, action: 'inspect',
      });
      expect(JSON.parse(inspected.text).edited_root).toMatchObject({ name: 'UnsavedHumanState' });
      expect((await second.call('editor_control', {
        projectPath: project.projectPath, action: 'undo',
      })).isError).toBe(false);
    } finally {
      if (first) await first.client.close().catch(() => undefined);
      await stopNormalEditors(project.root, [project.projectPath], [editor.child]);
      if (second) await second.close().catch(() => undefined);
    }
  }, 90_000);

  it('connects when the MCP starts first and Godot is then opened normally', async () => {
    const project = createTempProject();
    retainedRoots.add(project.root);
    installPersistentAddon(project.projectPath);
    const server = await startServer({ project, preserveProject: true });
    let editor: ReturnType<typeof startNormalEditor> | null = null;
    try {
      const before = await server.call('editor_session', {
        projectPath: project.projectPath, action: 'ensure', launchIfNeeded: false, timeoutSeconds: 0,
      });
      expect(before.isError, before.text).toBe(false);
      expect(JSON.parse(before.text)).toMatchObject({
        editor_session: { state: 'no_editor', connected: false, spawned: false },
      });
      editor = startNormalEditor(project.projectPath);
      await waitForDiscovery(project.projectPath, editor.diagnostics);
      const attached = await ensureConnected(server, project.projectPath);
      expect(attached).toMatchObject({ editor_session: { connected: true, reused: true, spawned: false } });
    } finally {
      await stopNormalEditors(project.root, [project.projectPath], editor ? [editor.child] : []);
      await server.close().catch(() => undefined);
    }
  }, 60_000);

  it('routes two normally opened project editors without cross-project mutations', async () => {
    const project = createTempProject();
    retainedRoots.add(project.root);
    const secondPath = join(project.root, 'second-project');
    mkdirSync(secondPath, { recursive: true });
    for (const file of ['project.godot', 'main.gd', 'main.tscn']) {
      copyFileSync(join(project.projectPath, file), join(secondPath, file));
    }
    installPersistentAddon(project.projectPath);
    installPersistentAddon(secondPath);
    const firstEditor = startNormalEditor(project.projectPath);
    const secondEditor = startNormalEditor(secondPath);
    await Promise.all([
      waitForDiscovery(project.projectPath, firstEditor.diagnostics),
      waitForDiscovery(secondPath, secondEditor.diagnostics),
    ]);
    const server = await startServer({ project, preserveProject: true });
    try {
      await Promise.all([
        ensureConnected(server, project.projectPath),
        ensureConnected(server, secondPath),
      ]);
      const firstMutation = await server.call('editor_transaction', {
        projectPath: project.projectPath, scenePath: 'main.tscn', name: 'Route first project',
        operations: [{ op: 'add_node', parentPath: '.', nodeType: 'Node2D', nodeName: 'OnlyFirst' }],
        focusPath: 'OnlyFirst', save: true,
      });
      const secondMutation = await server.call('editor_transaction', {
        projectPath: secondPath, scenePath: 'main.tscn', name: 'Route second project',
        operations: [{ op: 'add_node', parentPath: '.', nodeType: 'Node2D', nodeName: 'OnlySecond' }],
        focusPath: 'OnlySecond', save: true,
      });
      expect(firstMutation.isError, firstMutation.text).toBe(false);
      expect(secondMutation.isError, secondMutation.text).toBe(false);
      expect(readFileSync(join(project.projectPath, 'main.tscn'), 'utf8')).toMatch(/OnlyFirst/);
      expect(readFileSync(join(project.projectPath, 'main.tscn'), 'utf8')).not.toMatch(/OnlySecond/);
      expect(readFileSync(join(secondPath, 'main.tscn'), 'utf8')).toMatch(/OnlySecond/);
      expect(readFileSync(join(secondPath, 'main.tscn'), 'utf8')).not.toMatch(/OnlyFirst/);
      const firstInspect = await server.call('editor_control', {
        projectPath: project.projectPath, action: 'inspect',
      });
      const secondInspect = await server.call('editor_control', {
        projectPath: secondPath, action: 'inspect',
      });
      expect(JSON.parse(firstInspect.text).selection).toEqual(expect.arrayContaining([expect.stringMatching(/OnlyFirst$/)]));
      expect(JSON.parse(secondInspect.text).selection).toEqual(expect.arrayContaining([expect.stringMatching(/OnlySecond$/)]));
    } finally {
      await stopNormalEditors(project.root, [project.projectPath, secondPath], [firstEditor.child, secondEditor.child]);
      await server.close().catch(() => undefined);
    }
  }, 90_000);
});
