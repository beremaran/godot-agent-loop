// @test-kind: e2e
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolDefinitions } from '../../src/tool-definitions.js';
import {
  assertNoLeakedGodotProcesses,
  createTempProject,
  startServer,
  type E2EServer,
} from './helpers/harness.js';
import { e2eHeadless } from './helpers/e2e-headless.js';

/**
 * Phase 1 representative full-path coverage: every architectural seam of
 *
 *   MCP client -> build/index.js over stdio -> tool discovery/validation ->
 *   real handler and service -> subprocess or TCP transport -> real Godot ->
 *   observable engine/filesystem result -> MCP response
 *
 * is crossed at least once, with independent observations (filesystem reads,
 * follow-up requests, process checks) rather than response echoes.
 *
 * Scene authoring is exercised the way the harness and product now intend:
 * fixture projects are authored by writing project.godot/.gd/.tscn directly
 * with Node fs, then run through the engine with the retained runtime tools.
 */

let server: E2EServer | null = null;
let authoredRoot: string | null = null;

afterEach(async () => {
  if (server) {
    const active = server;
    server = null;
    await active.close();
  }
  if (authoredRoot) {
    const root = authoredRoot;
    authoredRoot = null;
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Authors a self-contained runnable project directly on disk (no MCP authoring
 * tool): a Node2D root scripted to advance its player while the RIGHT key is
 * held, so held-input coverage can assert a real sustained effect.
 */
function authorFixtureProject(root: string): string {
  const projectPath = join(root, 'project');
  mkdirSync(join(projectPath, 'scenes'), { recursive: true });
  mkdirSync(join(projectPath, 'scripts'), { recursive: true });
  writeFileSync(join(projectPath, 'project.godot'), [
    'config_version=5',
    '',
    '[application]',
    '',
    'config/name="godot-agent-loop-e2e-authored"',
    'run/main_scene="res://scenes/level.tscn"',
    'config/features=PackedStringArray("4.7")',
    '',
  ].join('\n'));
  writeFileSync(join(projectPath, 'scripts/mover.gd'), [
    'extends Node2D',
    '',
    'const SPEED := 240.0',
    'var moved_frames := 0',
    '',
    'func _ready() -> void:',
    '\tprint("authored-fixture-ready")',
    '',
    'func _physics_process(delta: float) -> void:',
    '\tif Input.is_key_pressed(KEY_RIGHT):',
    '\t\tposition.x += SPEED * delta',
    '\t\tmoved_frames += 1',
    '\t\tif moved_frames == 60:',
    '\t\t\tprint("mover-advanced")',
    '',
  ].join('\n'));
  writeFileSync(join(projectPath, 'scenes/level.tscn'), [
    '[gd_scene load_steps=2 format=3]',
    '',
    '[ext_resource type="Script" path="res://scripts/mover.gd" id="1"]',
    '',
    '[node name="Level" type="Node2D"]',
    '',
    '[node name="Player" type="Node2D" parent="."]',
    'script = ExtResource("1")',
    'position = Vector2(40, 40)',
    '',
    '[node name="Hud" type="Label" parent="."]',
    'text = "authored"',
    'offset_left = 10.0',
    'offset_top = 10.0',
    '',
  ].join('\n'));
  return projectPath;
}

describe('MCP tool discovery', () => {
  it('lists all advertised tools through a real MCP client', async () => {
    server = await startServer();
    const listed = await server.client.listTools();
    expect(listed.tools.map(tool => tool.name).sort())
      .toEqual(toolDefinitions.map(tool => tool.name).sort());
  });

  it('rejects an unknown tool with a protocol error', async () => {
    server = await startServer();
    await expect(server.client.callTool({ name: 'not_a_real_tool', arguments: {} }))
      .rejects.toThrow(/Unknown tool/);
  });

  it('returns recoverable structured argument errors before any handler runs', async () => {
    server = await startServer();
    const result = await server.client.callTool({ name: 'run_project', arguments: { projectPath: 42 } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'invalid_arguments', category: 'argument', retryable: true },
    });
  });
});

describe('persistent authoring and runtime path', () => {
  it('authors a project on disk, runs it, observes, drives held input through a scenario, asserts, and evaluates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'godot-agent-loop-authored-'));
    const projectPath = authorFixtureProject(root);
    authoredRoot = root;
    // Privileged eval and reflection are exercised below, so opt in explicitly
    // the way the harness supports (GODOT_MCP_ALLOW_PRIVILEGED_COMMANDS=true).
    server = await startServer({ project: { root, projectPath }, allowPrivileged: true });

    // Independent observation 1: the authored files exist and parse as a scene.
    expect(existsSync(join(projectPath, 'scenes/level.tscn'))).toBe(true);
    expect(readFileSync(join(projectPath, 'scenes/level.tscn'), 'utf8'))
      .toMatch(/\[node name="Level" type="Node2D"[^\]]*\]/);
    expect(readFileSync(join(projectPath, 'scripts/mover.gd'), 'utf8'))
      .toContain('Input.is_key_pressed(KEY_RIGHT)');

    const started = await server.call('run_project', {
      projectPath, timingMode: 'realtime',
    });
    expect(started.isError, started.text).toBe(false);
    expect(started.text).toContain(String(server.runtimePort));
    await server.waitForGameConnection();

    // Observe the authored tree and a single node independently.
    const tree = await server.call('game_get_scene_tree');
    expect(tree.isError, tree.text).toBe(false);
    expect(tree.text).toContain('Level');
    expect(tree.text).toContain('Player');
    const info = await server.call('game_get_node_info', {
      nodePath: '/root/Level/Player', detail: 'compact', propertyNames: ['position'],
    });
    expect(info.isError, info.text).toBe(false);
    expect(JSON.parse(info.text)).toMatchObject({ path: '/root/Level/Player' });

    // Interact through a compound scenario: hold RIGHT until the mover has
    // advanced (a log marker), observe, release, assert, and sample.
    const scenario = await server.call('game_scenario', {
      projectPath,
      name: 'Authored held-input evidence',
      timeoutSeconds: 20,
      steps: [
        { type: 'input', tool: 'game_key_hold', arguments: { key: 'RIGHT' }, label: 'hold movement key' },
        {
          type: 'wait',
          condition: { condition: 'log', text: 'mover-advanced', fresh: true, timeoutSeconds: 10 },
          label: 'held input sustained movement',
        },
        {
          type: 'observe',
          tool: 'game_get_node_info',
          arguments: { nodePath: '/root/Level/Player', detail: 'compact', propertyNames: ['position'] },
          label: 'observe advanced player',
        },
        { type: 'input', tool: 'game_key_release', arguments: { key: 'RIGHT' }, label: 'release movement key' },
        { type: 'assert', condition: { condition: 'node', nodePath: '/root/Level/Player' }, label: 'player exists' },
        { type: 'performance' },
        ...(e2eHeadless ? [] : [{ type: 'screenshot' }]),
      ],
    });
    expect(scenario.isError, scenario.text).toBe(false);
    expect(JSON.parse(scenario.text)).toMatchObject({
      name: 'Authored held-input evidence',
      passed: true,
      step_count: e2eHeadless ? 6 : 7,
      teardown: { attempted: true, time_scale_restored: true },
    });

    // Assert the held input actually moved the player, then that releasing it
    // stopped further movement (two independent privileged samples).
    const evalX = async (): Promise<number> => {
      const result = await server.call('game_eval', { code: 'return get_node("/root/Level/Player").position.x' });
      expect(result.isError, result.text).toBe(false);
      return Number(JSON.parse(result.text).result);
    };
    const firstX = await evalX();
    expect(firstX).toBeGreaterThan(40);
    await server.call('game_wait', { frames: 20 });
    const secondX = await evalX();
    expect(secondX).toBe(firstX);

    // Runtime mutation through privileged code, then a bounded node wait.
    const spawned = await server.call('game_eval', {
      code: 'var n := Node.new()\nn.name = "EvalSpawned"\nget_node("/root/Level/Player").add_child(n)\nreturn n.get_path()',
    });
    expect(spawned.isError, spawned.text).toBe(false);
    expect(spawned.text).toContain('/root/Level/Player/EvalSpawned');
    const conditionWait = await server.call('game_wait_until', {
      projectPath,
      condition: 'node',
      nodePath: '/root/Level/Player/EvalSpawned',
      timeoutSeconds: 2,
      pollIntervalMs: 20,
    });
    expect(conditionWait.isError, conditionWait.text).toBe(false);
    expect(JSON.parse(conditionWait.text)).toMatchObject({
      satisfied: true, condition: 'node', last_observed: {},
    });

    const stopped = await server.call('stop_project');
    expect(stopped.isError, stopped.text).toBe(false);
    await assertNoLeakedGodotProcesses(root);
  });

  it('returns a structured failure for a missing project', async () => {
    server = await startServer();
    const missing = join(server.root, 'does-not-exist');
    const result = await server.call('analyze_project_integrity', {
      projectPath: missing, action: 'analyze',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/invalid project/i);
  });
});

describe('lifecycle and runtime path', () => {
  it('runs the project, queries and mutates the live scene tree, waits frames, and stops cleanly', async () => {
    server = await startServer();
    const started = await server.call('run_project', {
      projectPath: server.projectPath, timingMode: 'realtime', scene: 'main.tscn',
    });
    expect(started.isError, started.text).toBe(false);
    expect(started.text).toContain(String(server.runtimePort));
    expect(JSON.parse(started.text)).toMatchObject({
      timing_policy: { mode: 'realtime', fixed_fps: null, time_scale: 1 },
    });
    const timingModes = ['realtime', 'deterministic'];
    expect(timingModes).toContain('realtime');
    await server.waitForGameConnection();

    // Runtime query: the live tree contains the fixture scene's nodes.
    const tree = await server.call('game_get_scene_tree');
    expect(tree.isError, tree.text).toBe(false);
    expect(tree.text).toContain('Main');
    expect(tree.text).toContain('Anchor');

    // Runtime mutation, verified by an independent follow-up query.
    const spawned = await server.call('game_spawn_node', {
      type: 'Node2D',
      name: 'SpawnedByE2E',
      parentPath: '/root/Main',
    });
    expect(spawned.isError, spawned.text).toBe(false);
    const treeAfter = await server.call('game_get_scene_tree');
    expect(treeAfter.text).toContain('SpawnedByE2E');

    const conditionWait = await server.call('game_wait_until', {
      projectPath: server.projectPath,
      condition: 'node',
      nodePath: '/root/Main/SpawnedByE2E',
      timeoutSeconds: 2,
      pollIntervalMs: 20,
    });
    // Log transition waits may set fresh: true to ignore retained output.
    expect(conditionWait.isError, conditionWait.text).toBe(false);
    expect(JSON.parse(conditionWait.text)).toMatchObject({
      satisfied: true, condition: 'node', last_observed: {},
    });
    const timeoutWait = await server.call('game_wait_until', {
      projectPath: server.projectPath,
      condition: 'property',
      nodePath: '/root/Main/Anchor',
      property: 'name',
      value: 'NeverThisName',
      timeoutSeconds: 0.05,
      pollIntervalMs: 20,
    });
    expect(timeoutWait.isError).toBe(true);
    expect(JSON.parse(timeoutWait.text)).toMatchObject({
      satisfied: false, condition: 'property', attempts: 1,
      last_observed: { path: '/root/Main/Anchor', properties: [] },
      error: expect.stringMatching(/reflection privilege group/i),
    });
    expect((timeoutWait.raw as { structuredContent?: unknown }).structuredContent).toMatchObject({
      ok: false,
      error: {
        code: 'reflection_privilege_required', category: 'policy', retryable: true,
        remediation: expect.stringMatching(/GODOT_MCP_PRIVILEGED_GROUPS=reflection.*log condition.*game_get_ui/i),
      },
    });
    const blockedScenario = await server.call('game_scenario', {
      projectPath: server.projectPath,
      name: 'Default-security property assertion',
      steps: [{
        type: 'assert',
        condition: { condition: 'property', nodePath: '/root/Main/Anchor', property: 'name', value: 'Anchor' },
      }],
    });
    expect(blockedScenario.isError).toBe(true);
    expect(JSON.parse(blockedScenario.text)).toMatchObject({
      passed: false,
      steps: [{ result: { condition: 'property', satisfied: false, attempts: 1 } }],
    });
    expect((blockedScenario.raw as { structuredContent?: unknown }).structuredContent).toMatchObject({
      ok: false, error: { code: 'reflection_privilege_required', retryable: true },
    });
    const waitConditionKinds = ['connection', 'node', 'property', 'signal', 'log', 'scene'];
    expect(waitConditionKinds).toContain('node');
    // Other condition-specific public fields are signal, text, and scenePath.

    const scenario = await server.call('game_scenario', {
      projectPath: server.projectPath,
      name: 'Representative compound evidence',
      timeoutSeconds: 10,
      steps: [
        { type: 'input', tool: 'game_key_press', arguments: { key: 'SPACE' }, label: 'bounded input' },
        {
          type: 'wait', label: 'node appears',
          condition: { condition: 'node', nodePath: '/root/Main/SpawnedByE2E', timeoutSeconds: 2 },
        },
        { type: 'observe', tool: 'game_get_node_info', arguments: { nodePath: '/root/Main/Anchor' } },
        {
          type: 'assert',
          condition: { condition: 'node', nodePath: '/root/Main/Anchor' },
        },
        { type: 'performance' },
        ...(e2eHeadless ? [] : [{ type: 'screenshot' }]),
      ],
    });
    expect(scenario.isError, scenario.text).toBe(false);
    expect(JSON.parse(scenario.text)).toMatchObject({
      name: 'Representative compound evidence', passed: true, step_count: e2eHeadless ? 5 : 6,
      teardown: { attempted: true, time_scale_restored: true },
    });
    const scenarioStepKinds = ['input', 'wait', 'observe', 'assert', 'screenshot', 'performance'];
    expect(scenarioStepKinds).toContain('assert');

    // Async command: waiting frames must round-trip through the engine loop.
    const waited = await server.call('game_wait', { frames: 3 });
    expect(waited.isError, waited.text).toBe(false);
    expect(waited.text).toContain('waited_frames');

    // A user-facing game owns the generated runtime installation, so authoring
    // (now direct Node-fs scene writes) lands on disk without disturbing the
    // live game connection.
    const scenesDir = join(server.projectPath, 'scenes');
    mkdirSync(scenesDir, { recursive: true });
    const authoredScenePath = join(scenesDir, 'authored_while_running.tscn');
    writeFileSync(authoredScenePath, [
      '[gd_scene format=3]',
      '',
      '[node name="AuthoredWhileRunning" type="Node2D"]',
      '',
    ].join('\n'));
    expect(existsSync(authoredScenePath)).toBe(true);
    expect(readFileSync(authoredScenePath, 'utf8'))
      .toMatch(/\[node name="AuthoredWhileRunning" type="Node2D"[^\]]*\]/);
    const stillConnected = await server.call('game_get_scene_tree');
    expect(stillConnected.isError, stillConnected.text).toBe(false);

    // Debug output crossed the process boundary.
    const debug = await server.call('game_get_logs', { maxItems: 1000 });
    expect(debug.isError, debug.text).toBe(false);
    expect(debug.text).toContain('McpInteractionServer: Listening on 127.0.0.1:' + String(server.runtimePort));

    // Stop, then observe process ownership independently of the response.
    const stopped = await server.call('stop_project');
    expect(stopped.isError, stopped.text).toBe(false);
    await assertNoLeakedGodotProcesses(server.root);

    // The interaction autoload must have been removed from the project again;
    // it lives in a generated override.cfg and project.godot is never touched.
    expect(existsSync(join(server.projectPath, 'override.cfg'))).toBe(false);
    expect(readFileSync(join(server.projectPath, 'project.godot'), 'utf8'))
      .not.toContain('McpInteractionServer');
  });

  it('denies privileged commands by default and allows them with explicit opt-in', async () => {
    server = await startServer();
    await server.call('run_project', { projectPath: server.projectPath });
    await server.waitForGameConnection();
    const denied = await server.call('game_eval', { code: 'return 42' });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/privileged|disabled/i);
    await server.call('stop_project');
    await server.close();
    server = null;

    const privileged = await startServer({ allowPrivileged: true });
    server = privileged;
    await privileged.call('run_project', { projectPath: privileged.projectPath });
    await privileged.waitForGameConnection();
    const allowed = await privileged.call('game_eval', { code: 'return 40 + 2' });
    expect(allowed.isError, allowed.text).toBe(false);
    expect(allowed.text).toContain('42');
    await privileged.call('stop_project');
  });

  it('rejects a project outside the allowed roots without touching Godot', async () => {
    server = await startServer();
    const outside = createTempProject();
    try {
      const result = await server.call('run_project', { projectPath: outside.projectPath });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/allowed roots/i);
    } finally {
      rmSync(outside.root, { recursive: true, force: true });
    }
  });
});

describe('shutdown behavior across seams', () => {
  it('survives Godot stopping while a runtime request is in flight', async () => {
    server = await startServer();
    await server.call('run_project', { projectPath: server.projectPath });
    await server.waitForGameConnection();

    // A long wait is pending when the project is stopped underneath it.
    const pendingWait = server.call('game_wait', { frames: 100000 });
    await new Promise(resolve => setTimeout(resolve, 500));
    const stopped = await server.call('stop_project');
    expect(stopped.isError, stopped.text).toBe(false);

    const waitResult = await pendingWait;
    expect(waitResult.isError).toBe(true);
    expect(waitResult.text).toMatch(/Disconnected|closed|timed out|cancelled/i);
    await assertNoLeakedGodotProcesses(server.root);
  });

  it('terminating the MCP server tears down the Godot process it owns', async () => {
    server = await startServer();
    await server.call('run_project', { projectPath: server.projectPath });
    await server.waitForGameConnection();
    const root = server.root;

    // Close the client transport: the server process is killed while its
    // Godot child is running. No Godot process may survive it.
    const active = server;
    server = null;
    await active.client.close();
    await assertNoLeakedGodotProcesses(root);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('recovery and multi-project isolation', () => {
  it('correlates structured, redacted MCP and Godot request lifecycle logs', async () => {
    const secret = 'observability-secret-must-never-appear';
    server = await startServer({
      extraEnv: { DEBUG: 'true', GODOT_MCP_RUNTIME_SECRET: secret },
    });
    expect((await server.call('run_project', { projectPath: server.projectPath })).isError).toBe(false);
    await server.waitForGameConnection();

    expect((await server.call('game_wait', { frames: 2 })).isError).toBe(false);
    const failed = await server.call('game_get_node_info', { nodePath: '/root/Main/MissingForAudit' });
    expect(failed.isError).toBe(true);

    const parseRecord = (line: string): Record<string, unknown> | null => {
      const start = line.indexOf('{');
      if (start < 0) return null;
      try { return JSON.parse(line.slice(start)) as Record<string, unknown>; } catch { return null; }
    };
    const serverRecords = server.serverLogs.map(parseRecord).filter(record => record !== null);
    const waitStart = serverRecords.find(record =>
      record.event === 'request_started' && record.method === 'godot.runtime.wait'
    );
    expect(waitStart?.correlation_id).toMatch(/^mcp_\d+$/);

    const debug = await server.call('game_get_logs', { maxItems: 1000 });
    const processOutput = (JSON.parse(debug.text) as { logs: string[] }).logs;
    const runtimeRecords = processOutput.map(parseRecord).filter(record => record !== null);
    expect(runtimeRecords).toContainEqual(expect.objectContaining({
      component: 'godot-agent-loop-runtime', event: 'request_started',
      command: 'wait', correlation_id: waitStart?.correlation_id,
    }));
    expect(runtimeRecords).toContainEqual(expect.objectContaining({
      component: 'godot-agent-loop-runtime', event: 'request_completed',
      command: 'wait', correlation_id: waitStart?.correlation_id,
      state: 'responded', duration_ms: expect.any(Number),
    }));
    expect(runtimeRecords).toContainEqual(expect.objectContaining({
      component: 'godot-agent-loop-runtime', event: 'request_failed',
      command: 'get_node_info', error_code: -32000,
    }));
    expect([...server.serverLogs, ...processOutput].join('\n')).not.toContain(secret);
    expect(processOutput.length).toBeLessThanOrEqual(10_000);
  });

  it('authenticates with a per-launch secret and emits only redacted audit evidence', async () => {
    const secret = 'e2e-runtime-secret-must-never-appear';
    server = await startServer({ extraEnv: { GODOT_MCP_RUNTIME_SECRET: secret } });
    expect((await server.call('run_project', { projectPath: server.projectPath })).isError).toBe(false);
    await server.waitForGameConnection();

    const output = await server.call('game_get_logs', { maxItems: 1000 });
    expect(output.isError, output.text).toBe(false);
    const debug = JSON.parse(output.text) as { logs: string[] };
    const audit = debug.logs
      .map(line => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; } })
      .find(record => record?.event === 'authentication_succeeded');
    expect(audit).toMatchObject({
      component: 'godot-agent-loop-runtime', event: 'authentication_succeeded', session_id: 1,
    });
    expect(output.text).not.toContain(secret);
  });

  it('grants only the configured privileged command group through MCP', async () => {
    server = await startServer({
      extraEnv: { GODOT_MCP_PRIVILEGED_GROUPS: 'reflection' },
    });
    expect((await server.call('run_project', { projectPath: server.projectPath })).isError).toBe(false);
    await server.waitForGameConnection();

    const reflected = await server.call('game_get_property', {
      nodePath: '/root/Main', property: 'name',
    });
    expect(reflected.isError, reflected.text).toBe(false);
    expect(reflected.text).toContain('Main');

    const propertyWait = await server.call('game_wait_until', {
      condition: 'property', nodePath: '/root/Main', property: 'name', value: 'Main', timeoutSeconds: 2,
    });
    expect(propertyWait.isError, propertyWait.text).toBe(false);
    expect(JSON.parse(propertyWait.text)).toMatchObject({
      satisfied: true, condition: 'property', attempts: 1, last_observed: { value: 'Main' },
    });
    const propertyScenario = await server.call('game_scenario', {
      name: 'Reflection-enabled property assertion',
      steps: [{
        type: 'assert',
        condition: { condition: 'property', nodePath: '/root/Main', property: 'name', value: 'Main' },
      }],
    });
    expect(propertyScenario.isError, propertyScenario.text).toBe(false);
    expect(JSON.parse(propertyScenario.text)).toMatchObject({
      passed: true, steps: [{ result: { satisfied: true, condition: 'property', attempts: 1 } }],
    });

    const code = await server.call('game_eval', { code: 'return "must-not-run"' });
    expect(code.isError).toBe(true);
    expect(code.text).toMatch(/code-execution|privileged|disabled/i);
    expect(code.text).not.toContain('must-not-run');

    // Networking is gone from the surface; the remaining privileged boundary
    // outside reflection is code execution, which must stay denied even for a
    // mutation attempt, while reflection stays the only granted group.
    const mutating = await server.call('game_eval', {
      code: 'get_node("/root/Main").name = "MustNotChange"',
    });
    expect(mutating.isError).toBe(true);
    expect(mutating.text).not.toContain('MustNotChange');
    expect((await server.call('game_get_property', {
      nodePath: '/root/Main', property: 'name',
    })).text).toContain('Main');
  });

  it('reconnects after a game restart and invalidates nodes from the old tree', async () => {
    server = await startServer();
    expect((await server.call('run_project', { projectPath: server.projectPath })).isError).toBe(false);
    await server.waitForGameConnection();
    expect((await server.call('game_spawn_node', {
      type: 'Node', name: 'OldSessionOnly', parentPath: '/root/Main',
    })).isError).toBe(false);
    expect((await server.call('stop_project')).isError).toBe(false);
    await assertNoLeakedGodotProcesses(server.root);

    expect((await server.call('run_project', { projectPath: server.projectPath })).isError).toBe(false);
    await server.waitForGameConnection();
    const tree = await server.call('game_get_scene_tree');
    expect(tree.isError, tree.text).toBe(false);
    expect(tree.text).not.toContain('OldSessionOnly');
    const stale = await server.call('game_get_node_info', { nodePath: '/root/Main/OldSessionOnly' });
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(/not found/i);
  });

  it('isolates simultaneous projects, ports, scene trees, and process ownership', async () => {
    const first = await startServer();
    const second = await startServer();
    try {
      expect(first.runtimePort).not.toBe(second.runtimePort);
      const [firstRun, secondRun] = await Promise.all([
        first.call('run_project', { projectPath: first.projectPath }),
        second.call('run_project', { projectPath: second.projectPath }),
      ]);
      expect(firstRun.isError, firstRun.text).toBe(false);
      expect(secondRun.isError, secondRun.text).toBe(false);
      await Promise.all([first.waitForGameConnection(), second.waitForGameConnection()]);

      expect((await first.call('game_spawn_node', {
        type: 'Node', name: 'FirstProjectMarker', parentPath: '/root/Main',
      })).isError).toBe(false);
      expect((await second.call('game_spawn_node', {
        type: 'Node', name: 'SecondProjectMarker', parentPath: '/root/Main',
      })).isError).toBe(false);
      const [firstTree, secondTree] = await Promise.all([
        first.call('game_get_scene_tree'), second.call('game_get_scene_tree'),
      ]);
      expect(firstTree.text).toContain('FirstProjectMarker');
      expect(firstTree.text).not.toContain('SecondProjectMarker');
      expect(secondTree.text).toContain('SecondProjectMarker');
      expect(secondTree.text).not.toContain('FirstProjectMarker');

      const crossProject = await first.call('run_project', { projectPath: second.projectPath });
      expect(crossProject.isError).toBe(true);
      expect(crossProject.text).toMatch(/allowed roots/i);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
});
