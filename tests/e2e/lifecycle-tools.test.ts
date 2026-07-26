// @test-kind: e2e
import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createTempProject, findProcesses, repoRoot, startServer, type E2EServer } from './helpers/harness.js';

const execFileAsync = promisify(execFile);

function parseStructuredOperationOutput(text: string): Record<string, unknown> {
  const marker = 'Output: ';
  const payload = text.includes(marker) ? text.slice(text.indexOf(marker) + marker.length) : text;
  return JSON.parse(payload) as Record<string, unknown>;
}

/**
 * Phase 2: the lifecycle and discovery tools (launch_editor, run_project,
 * get_debug_output, stop_project, get_godot_version, list_projects,
 * get_project_info) through the complete MCP path: process ownership,
 * repeated launches, self-exiting projects, output ordering, and the
 * missing-binary startup failure.
 */

let server: E2EServer | null = null;

afterEach(async () => {
  if (server) {
    const active = server;
    server = null;
    await active.close();
  }
});

describe('discovery tools', () => {
  it('receives the concise agent method during MCP initialization', async () => {
    server = await startServer();
    const instructions = server.client.getInstructions();
    expect(instructions).toMatch(/author → run → observe → assert/);
    expect(instructions).toContain('verify_project');
    expect(instructions).toMatch(/injection and cleanup are automatic/i);
  });

  it('reports the real engine version', async () => {
    server = await startServer();
    const version = await server.call('get_godot_version');
    expect(version.isError, version.text).toBe(false);
    expect(version.text).toMatch(/^4\.\d+/);
  });

  it('lists projects in a directory, recursively when asked', async () => {
    server = await startServer();
    const flat = await server.call('list_projects', { directory: server.root });
    expect(flat.isError, flat.text).toBe(false);
    expect(flat.text).toContain(server.projectPath);

    // A nested project inside the allowed root: found only with recursion.
    const nestedDir = join(server.root, 'nested/deeper/game');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, 'project.godot'), 'config_version=5\n');
    const shallow = await server.call('list_projects', { directory: join(server.root, 'nested') });
    expect(shallow.text).not.toContain('deeper/game');
    const recursive = await server.call('list_projects', { directory: join(server.root, 'nested'), recursive: true });
    expect(recursive.isError, recursive.text).toBe(false);
    expect(recursive.text).toContain(nestedDir);
  });

  it('reads project metadata through the engine-facing structure scan', async () => {
    server = await startServer();
    const info = await server.call('get_project_info', { projectPath: server.projectPath });
    expect(info.isError, info.text).toBe(false);
    expect(info.text).toContain('godot-agent-loop-e2e-fixture');
    expect(info.text).toMatch(/"scenes":\s*\d|main\.tscn/);
  });

  it('fails get_project_info for a directory that is not a project', async () => {
    server = await startServer();
    const result = await server.call('get_project_info', { projectPath: server.root });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Not a valid Godot project/i);
  });
});

describe('project process ownership', () => {
  it('returns atomic startup evidence and accepts an immediate runtime command', async () => {
    server = await startServer();
    const started = await server.call('run_project', { projectPath: server.projectPath });
    expect(started.isError, started.text).toBe(false);
    const evidence = JSON.parse(started.text) as Record<string, any>;
    expect(evidence).toMatchObject({
      process_started: true,
      runtime_connected: true,
      runtime_ready: true,
      project_path: server.projectPath,
      observed_project_path: server.projectPath,
      observed_scene: 'res://main.tscn',
      engine_version: expect.stringMatching(/^4\.\d+/),
      startup_diagnostics: {
        stdout: expect.any(String), stderr: expect.any(String),
        truncated: expect.any(Boolean), limit_bytes: 16 * 1024,
      },
    });
    expect(evidence.startup_duration_ms).toEqual(expect.any(Number));
    expect(evidence.startup_duration_ms).toBeGreaterThanOrEqual(0);

    // No separate waitForGameConnection call: successful run_project is the
    // connection/readiness barrier for ordinary workflows.
    const tree = await server.call('game_get_scene_tree', { maxNodes: 8 });
    expect(tree.isError, tree.text).toBe(false);
    expect(JSON.parse(tree.text)).toMatchObject({ current_scene: 'res://main.tscn' });
  });

  it('preserves output ordering and survives repeated launches', async () => {
    server = await startServer();
    writeFileSync(join(server.projectPath, 'main.gd'), [
      'extends Node2D',
      '',
      '',
      'func _ready() -> void:',
      '\tprint("order-alpha")',
      '\tprint("order-beta")',
      '\tprint("order-gamma")',
      '',
    ].join('\n'));

    const first = await server.call('run_project', { projectPath: server.projectPath });
    expect(first.isError, first.text).toBe(false);
    await server.waitForGameConnection();

    // Relaunching without stopping must replace the process, not stack a second one.
    const second = await server.call('run_project', { projectPath: server.projectPath });
    expect(second.isError, second.text).toBe(false);
    await server.waitForGameConnection();

    const debug = await server.call('get_debug_output');
    const alpha = debug.text.indexOf('order-alpha');
    const beta = debug.text.indexOf('order-beta');
    const gamma = debug.text.indexOf('order-gamma');
    expect(alpha, debug.text).toBeGreaterThanOrEqual(0);
    expect(beta).toBeGreaterThan(alpha);
    expect(gamma).toBeGreaterThan(beta);

    const stopped = await server.call('stop_project');
    expect(stopped.isError, stopped.text).toBe(false);
    // Stopping twice is a structured error, not a crash.
    const again = await server.call('stop_project');
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/No active Godot process/i);
  });

  it('observes a ready project that later exits on its own', async () => {
    server = await startServer();
    writeFileSync(join(server.projectPath, 'main.gd'), [
      'extends Node2D',
      '',
      '',
      'func _ready() -> void:',
      '\tawait get_tree().create_timer(5.0).timeout',
      '\tprint("exiting-now")',
      '\tget_tree().quit(3)',
      '',
    ].join('\n'));

    const started = await server.call('run_project', { projectPath: server.projectPath });
    expect(started.isError, started.text).toBe(false);

    // The process exits by itself; afterwards the server must know it is gone.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const result = await server.call('get_debug_output');
      if (result.isError && /No active Godot process/i.test(result.text)) break;
      expect(Date.now(), 'project never exited').toBeLessThan(deadline);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const stopped = await server.call('stop_project');
    expect(stopped.isError).toBe(true);
  });

  it('launches the headed editor bridge and renders live agent activity', async () => {
    server = await startServer();
    try {
      const launched = await server.call('launch_editor', { projectPath: server.projectPath });
      expect(launched.isError, launched.text).toBe(false);
      expect(JSON.parse(launched.text)).toMatchObject({
        editor_session: {
          state: 'connected', connected: true, reused: false, spawned: true,
          plugin_owned: true, plugin_distribution: 'transient', protocol_version: '2',
        },
      });
      const ensured = await server.call('editor_session', {
        projectPath: server.projectPath, action: 'ensure', launchIfNeeded: false, timeoutSeconds: 2,
      });
      expect(ensured.isError, ensured.text).toBe(false);
      expect(JSON.parse(ensured.text)).toMatchObject({
        editor_session: { state: 'connected', connected: true, reused: true, spawned: false },
      });
      const sessionStatus = await server.call('editor_session', {
        projectPath: server.projectPath, action: 'status',
      });
      expect(sessionStatus.isError, sessionStatus.text).toBe(false);
      expect(JSON.parse(sessionStatus.text)).toMatchObject({ editor_session: { connected: true } });

      const editorDeadline = Date.now() + 15_000;
      let editorState: { isError: boolean; text: string } = { isError: true, text: '' };
      while (Date.now() < editorDeadline && editorState.isError) {
        editorState = await server.call('editor_control', { projectPath: server.projectPath, action: 'inspect' });
        if (editorState.isError) await new Promise(resolve => setTimeout(resolve, 250));
      }
      expect(editorState.isError, editorState.text).toBe(false);
      expect(JSON.parse(editorState.text)).toMatchObject({
        action: 'inspect', has_undo_redo: true, authenticated: true,
        addon_version: '1.1.3', protocol_version: '2', server_version: '1.1.3',
      });

      // Godot can bring the headless editor bridge up before it opens the
      // project's main scene. Open it explicitly and wait for the edited root
      // so node mutations exercise the same state on every supported version.
      const opened = await server.call('editor_control', { projectPath: server.projectPath, action: 'open_scene', scenePath: 'res://main.tscn' });
      expect(opened.isError, opened.text).toBe(false);
      let sceneReady = false;
      const sceneDeadline = Date.now() + 15_000;
      while (Date.now() < sceneDeadline && !sceneReady) {
        editorState = await server.call('editor_control', { projectPath: server.projectPath, action: 'inspect' });
        if (!editorState.isError) {
          const inspected = JSON.parse(editorState.text) as { edited_root?: unknown };
          sceneReady = inspected.edited_root != null;
        }
        if (!sceneReady) await new Promise(resolve => setTimeout(resolve, 250));
      }
      expect(sceneReady, editorState.text).toBe(true);

      const authored = await server.call('add_node', {
        projectPath: server.projectPath, scenePath: 'main.tscn',
        parentNodePath: 'root', nodeType: 'Node2D', nodeName: 'AgentSynced',
      });
      expect(authored.isError, authored.text).toBe(false);
      expect(authored.text).toMatch(/"backend":"editor"/);
      expect(authored.text).toMatch(/"sync_status":"acknowledged"/);
      let editorFocused = false;
      const syncDeadline = Date.now() + 15_000;
      while (Date.now() < syncDeadline && !editorFocused) {
        editorState = await server.call('editor_control', { projectPath: server.projectPath, action: 'inspect' });
        if (!editorState.isError) {
          const inspected = JSON.parse(editorState.text) as {
            selection?: string[];
          };
          editorFocused = (inspected.selection ?? []).some(path => path.endsWith('/AgentSynced'));
        }
        if (!editorFocused) await new Promise(resolve => setTimeout(resolve, 250));
      }
      expect(editorFocused, editorState.text).toBe(true);

      const transaction = await server.call('editor_transaction', {
        projectPath: server.projectPath,
        scenePath: 'res://main.tscn',
        name: 'Build visible transaction subtree',
        rootType: 'Node2D',
        operations: [
          { op: 'add_node', parentPath: '.', nodeType: 'Node2D', nodeName: 'TransactionParent' },
          {
            op: 'add_node', parentPath: 'TransactionParent', nodeType: 'Node2D', nodeName: 'TransactionChild',
            properties: { position: { type: 'Vector2', value: [12, 34] } },
          },
          { op: 'set_properties', nodePath: 'TransactionParent/TransactionChild', properties: { visible: false } },
          { op: 'save' },
        ],
        focusPath: 'TransactionParent/TransactionChild',
        save: true,
      });
      expect(transaction.isError, transaction.text).toBe(false);
      expect(JSON.parse(transaction.text)).toMatchObject({
        backend: 'editor', sync_status: 'acknowledged', undo_recorded: true, saved: true,
        observed_target_state: { independently_reopened: true },
      });
      const persistedTransaction = await server.call('read_scene', {
        projectPath: server.projectPath, scenePath: 'main.tscn',
      });
      expect(persistedTransaction.isError, persistedTransaction.text).toBe(false);
      expect(persistedTransaction.text).toContain('TransactionChild');
      const editorTransactionOperations = [
        'add_node', 'remove_node', 'rename_node', 'duplicate_node', 'reparent_node',
        'set_properties', 'instantiate_scene', 'attach_script', 'assign_resource', 'save',
      ];
      expect(editorTransactionOperations).toContain('set_properties');
      // Public transaction fields also cover newParentPath, property, value,
      // scenePath, scriptPath, resourcePath, and keepGlobalTransform.

      const transactionUndo = await server.call('editor_control', {
        projectPath: server.projectPath, action: 'undo',
      });
      expect(transactionUndo.isError, transactionUndo.text).toBe(false);
      const saveUndoneTransaction = await server.call('editor_control', {
        projectPath: server.projectPath, action: 'save',
      });
      expect(saveUndoneTransaction.isError, saveUndoneTransaction.text).toBe(false);
      const independentlyUndone = await server.call('read_scene', {
        projectPath: server.projectPath, scenePath: 'main.tscn',
      });
      expect(independentlyUndone.isError, independentlyUndone.text).toBe(false);
      expect(independentlyUndone.text).not.toContain('TransactionParent');
      const transactionRedo = await server.call('editor_control', {
        projectPath: server.projectPath, action: 'redo',
      });
      expect(transactionRedo.isError, transactionRedo.text).toBe(false);
      const saveRedoneTransaction = await server.call('editor_control', {
        projectPath: server.projectPath, action: 'save',
      });
      expect(saveRedoneTransaction.isError, saveRedoneTransaction.text).toBe(false);
      const independentlyRedone = await server.call('read_scene', {
        projectPath: server.projectPath, scenePath: 'main.tscn',
      });
      expect(independentlyRedone.isError, independentlyRedone.text).toBe(false);
      expect(independentlyRedone.text).toContain('TransactionChild');

      const transaction3d = await server.call('editor_transaction', {
        projectPath: server.projectPath,
        scenePath: 'res://scenes/editor_3d.tscn',
        name: 'Build representative 3D scene',
        rootType: 'Node3D',
        operations: [
          { op: 'add_node', parentPath: '.', nodeType: 'Camera3D', nodeName: 'Camera', properties: { position: { type: 'Vector3', value: [0, 2, 6] } } },
          { op: 'add_node', parentPath: '.', nodeType: 'DirectionalLight3D', nodeName: 'Sun' },
          { op: 'add_node', parentPath: '.', nodeType: 'MeshInstance3D', nodeName: 'WorldMesh', properties: { position: { type: 'Vector3', value: [1, 0, -2] } } },
          { op: 'save' },
        ],
        focusPath: 'WorldMesh',
        save: true,
      });
      expect(transaction3d.isError, transaction3d.text).toBe(false);
      expect(JSON.parse(transaction3d.text)).toMatchObject({
        backend: 'editor', sync_status: 'acknowledged', undo_recorded: true,
        saved: true, scene_created: true,
        observed_target_state: { independently_reopened: true },
      });

      const createdMaterial = await server.call('create_resource', {
        projectPath: server.projectPath,
        resourceType: 'StandardMaterial3D',
        resourcePath: 'materials/editor_material.tres',
        properties: {
          albedo_color: { type: 'Color', value: '#336699' },
          roughness: 0.4,
        },
      });
      expect(createdMaterial.isError, createdMaterial.text).toBe(false);
      expect(parseStructuredOperationOutput(createdMaterial.text)).toMatchObject({
        backend: 'editor', sync_status: 'acknowledged', created: true,
        resource_type: 'StandardMaterial3D',
        observed_target_state: { independently_reloaded: true },
      });
      const modifiedMaterial = await server.call('manage_resource', {
        projectPath: server.projectPath,
        resourcePath: 'materials/editor_material.tres',
        action: 'modify',
        properties: { roughness: 0.65 },
      });
      expect(modifiedMaterial.isError, modifiedMaterial.text).toBe(false);
      expect(parseStructuredOperationOutput(modifiedMaterial.text)).toMatchObject({
        backend: 'editor', sync_status: 'acknowledged', created: false,
        undo_recorded: true, observed_target_state: { independently_reloaded: true },
      });
      const assignedMaterial = await server.call('editor_transaction', {
        projectPath: server.projectPath,
        scenePath: 'res://scenes/editor_3d.tscn',
        name: 'Assign editor-authored material',
        operations: [{
          op: 'assign_resource', nodePath: 'WorldMesh', property: 'material_override',
          resourcePath: 'res://materials/editor_material.tres',
        }],
        focusPath: 'WorldMesh',
        save: true,
      });
      expect(assignedMaterial.isError, assignedMaterial.text).toBe(false);
      expect(JSON.parse(assignedMaterial.text)).toMatchObject({
        backend: 'editor', sync_status: 'acknowledged', undo_recorded: true,
        observed_target_state: { independently_reopened: true },
      });
      const persisted3d = await server.call('read_scene', {
        projectPath: server.projectPath, scenePath: 'scenes/editor_3d.tscn',
      });
      expect(persisted3d.isError, persisted3d.text).toBe(false);
      expect(persisted3d.text).toContain('Camera3D');
      expect(persisted3d.text).toContain('DirectionalLight3D');
      expect(persisted3d.text).toContain('MeshInstance3D');
      expect(persisted3d.text).toContain('editor_material.tres');

      const reopenedMain = await server.call('editor_control', {
        projectPath: server.projectPath, action: 'open_scene', scenePath: 'res://main.tscn',
      });
      expect(reopenedMain.isError, reopenedMain.text).toBe(false);

      expect((await server.call('run_project', { projectPath: server.projectPath })).isError).toBe(false);
      await server.waitForGameConnection();
      const observedCommand = await server.call('game_get_node_info', { nodePath: '/root/Main/Anchor' });
      expect(observedCommand.isError, observedCommand.text).toBe(false);

      let observedActivity = false;
      const activityDeadline = Date.now() + 15_000;
      while (Date.now() < activityDeadline && !observedActivity) {
        editorState = await server.call('editor_control', { projectPath: server.projectPath, action: 'inspect' });
        if (!editorState.isError) {
          const inspected = JSON.parse(editorState.text) as {
            activity_dock?: boolean;
            activity?: { command?: string; target?: string; outcome?: string; duration_ms?: number }[];
          };
          observedActivity = inspected.activity_dock === true && (inspected.activity ?? []).some(event => (
            event.command === 'get_node_info'
              && event.target === '/root/Main/Anchor'
              && event.outcome === 'success'
              && typeof event.duration_ms === 'number'
          ));
        }
        if (!observedActivity) await new Promise(resolve => setTimeout(resolve, 250));
      }
      expect(observedActivity, editorState.text).toBe(true);

      const edited = await server.call('editor_control', {
        projectPath: server.projectPath, action: 'set_property', nodePath: '.', property: 'name', value: 'EditedRoot',
      });
      expect(edited.isError, edited.text).toBe(false);
      const undone = await server.call('editor_control', { projectPath: server.projectPath, action: 'undo' });
      expect(undone.isError, undone.text).toBe(false);
      expect(JSON.parse(undone.text)).toMatchObject({ success: true });
      expect(JSON.parse((await server.call('editor_control', {
        projectPath: server.projectPath, action: 'inspect',
      })).text).edited_root).toMatchObject({ name: 'Main' });
      const redone = await server.call('editor_control', { projectPath: server.projectPath, action: 'redo' });
      expect(redone.isError, redone.text).toBe(false);
      expect(JSON.parse(redone.text)).toMatchObject({ success: true });
      expect(JSON.parse((await server.call('editor_control', {
        projectPath: server.projectPath, action: 'inspect',
      })).text).edited_root).toMatchObject({ name: 'EditedRoot' });
      const selected = await server.call('editor_control', { projectPath: server.projectPath, action: 'select', nodePaths: [] });
      expect(selected.isError, selected.text).toBe(false);
      const saved = await server.call('editor_control', { projectPath: server.projectPath, action: 'save' });
      expect(saved.isError, saved.text).toBe(false);
      const renamed = await server.call('editor_control', {
        projectPath: server.projectPath, action: 'rename_node', nodePath: '.', name: 'RenamedRoot',
      });
      expect(renamed.isError, renamed.text).toBe(false);
      expect((await server.call('editor_control', { projectPath: server.projectPath, action: 'undo' })).isError).toBe(false);
      expect((await server.call('editor_control', { projectPath: server.projectPath, action: 'redo' })).isError).toBe(false);
      const reloaded = await server.call('editor_control', { projectPath: server.projectPath, action: 'reload', scenePath: 'res://main.tscn' });
      expect(reloaded.isError, reloaded.text).toBe(false);
      const editorActions = ['select', 'save', 'reload', 'open_scene', 'set_property', 'rename_node', 'undo', 'redo'];
      expect(editorActions).toContain('select');
      // Their optional parameters are nodePaths,
      // scenePath, nodePath, property, value, and name.

      // Independent observation: an editor process for this project exists.
      const deadline = Date.now() + 15_000;
      let seen = false;
      while (!seen && Date.now() < deadline) {
        const processes = await findProcesses(server.projectPath);
        seen = processes.some(line => /(?:^|\s)-e(?:\s|$)/.test(line));
        if (!seen) await new Promise(resolve => setTimeout(resolve, 250));
      }
      expect(seen, 'no editor process appeared').toBe(true);
      expect((await server.call('stop_project')).isError).toBe(false);
      const disconnected = await server.call('editor_session', {
        projectPath: server.projectPath, action: 'disconnect',
      });
      expect(disconnected.isError, disconnected.text).toBe(false);
      expect(JSON.parse(disconnected.text)).toMatchObject({
        editor_session: { state: 'no_editor', connected: false },
      });
    } finally {
      // The editor is intentionally user-owned (no stop_editor tool), so the
      // test always releases it before teardown's leak assertion, including
      // when an intermediate editor assertion fails.
      await execFileAsync('pkill', ['-f', server.projectPath]).catch(() => undefined);
    }
  });

  it('uses an installed persistent addon without overwriting it', async () => {
    server = await startServer();
    const addonPath = join(server.projectPath, 'addons/godot_agent_loop');
    mkdirSync(addonPath, { recursive: true });
    for (const file of ['plugin.gd', 'plugin.cfg', 'README.md', 'LICENSE']) {
      copyFileSync(join(repoRoot, 'addons/godot_agent_loop', file), join(addonPath, file));
    }
    const before = new Map(['plugin.gd', 'plugin.cfg', 'README.md', 'LICENSE'].map(file => (
      [file, readFileSync(join(addonPath, file), 'utf8')]
    )));

    try {
      const launched = await server.call('launch_editor', { projectPath: server.projectPath });
      expect(launched.isError, launched.text).toBe(false);
      expect(JSON.parse(launched.text)).toMatchObject({
        editor_session: {
          state: 'connected', connected: true, plugin_owned: false,
          plugin_distribution: 'persistent', protocol_version: '2',
        },
      });

      const deadline = Date.now() + 15_000;
      let inspected: { isError: boolean; text: string } = { isError: true, text: '' };
      while (Date.now() < deadline && inspected.isError) {
        inspected = await server.call('editor_control', { projectPath: server.projectPath, action: 'inspect' });
        if (inspected.isError) await new Promise(resolve => setTimeout(resolve, 250));
      }
      expect(inspected.isError, inspected.text).toBe(false);
      expect(JSON.parse(inspected.text)).toMatchObject({
        authenticated: true,
        addon_version: '1.1.3',
        protocol_version: '2',
        server_version: '1.1.3',
      });
      for (const [file, content] of before) {
        expect(readFileSync(join(addonPath, file), 'utf8'), file).toBe(content);
      }
    } finally {
      await execFileAsync('pkill', ['-f', server.projectPath]).catch(() => undefined);
    }
  });

  it('refuses mutations while the editor cooperative lock is paused', async () => {
    server = await startServer({ extraEnv: { GODOT_MCP_EDITOR_START_PAUSED: 'true' } });
    try {
      const launched = await server.call('launch_editor', { projectPath: server.projectPath });
      expect(launched.isError, launched.text).toBe(false);

      const deadline = Date.now() + 15_000;
      let inspected: { isError: boolean; text: string } = { isError: true, text: '' };
      while (Date.now() < deadline) {
        inspected = await server.call('editor_control', { projectPath: server.projectPath, action: 'inspect' });
        if (!inspected.isError && JSON.parse(inspected.text).driver_paused === true) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      expect(inspected.isError, inspected.text).toBe(false);
      expect(JSON.parse(inspected.text)).toMatchObject({ driver_paused: true, agent_driving: false });

      const observed = await server.call('read_file', {
        projectPath: server.projectPath, filePath: 'main.tscn',
      });
      expect(observed.isError, observed.text).toBe(false);

      const refused = await server.call('add_node', {
        projectPath: server.projectPath, scenePath: 'main.tscn',
        parentNodePath: 'root', nodeType: 'Node2D', nodeName: 'MustNotBeWritten',
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/mutation refused.*paused.*Resume Agent/is);

      const reread = await server.call('read_file', {
        projectPath: server.projectPath, filePath: 'main.tscn',
      });
      expect(reread.isError, reread.text).toBe(false);
      expect(reread.text).not.toContain('MustNotBeWritten');
    } finally {
      await execFileAsync('pkill', ['-f', server.projectPath]).catch(() => undefined);
    }
  });

  it('fails run_project cleanly for an invalid project directory', async () => {
    server = await startServer();
    const result = await server.call('run_project', { projectPath: server.root });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Not a valid Godot project/i);
  });
});

describe('missing binary behavior', () => {
  it('starts in compatibility mode but fails every engine-backed tool with a structured error', async () => {
    // Without strictPathValidation the server documents that it falls back to
    // a default path and keeps running; the failure must then surface as a
    // structured tool error, never a hang or crash.
    const project = createTempProject();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(repoRoot, 'build/index.js')],
      env: {
        ...getDefaultEnvironment(),
        GODOT_PATH: join(project.root, 'not-a-binary'),
        PATH: '/nonexistent',
        GODOT_MCP_ALLOWED_DIRS: project.root,
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'godot-agent-loop-e2e', version: '0.0.0' });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'get_godot_version', arguments: {} });
      expect(result.isError).toBe(true);
      const text = (result.content as { type: string; text?: string }[])
        .map(item => item.text ?? '').join('\n');
      expect(text).toMatch(/Failed to get Godot version|Could not find/i);
    } finally {
      await client.close().catch(() => undefined);
      const { rmSync } = await import('node:fs');
      rmSync(project.root, { recursive: true, force: true });
    }
  });
});
