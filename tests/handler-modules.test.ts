// @test-kind: unit
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GameToolHandlers } from '../src/tool-handlers/game-tool-handlers.js';
import { LifecycleToolHandlers, type LifecycleToolHandlerContext } from '../src/tool-handlers/lifecycle-tool-handlers.js';
import { ProjectToolHandlers } from '../src/tool-handlers/project-tool-handlers.js';
import type { GodotProcess } from '../src/godot-process-manager.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createProject(): string {
  const directory = mkdtempSync(join(tmpdir(), 'godot-agent-loop-handler-'));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, 'project.godot'), '[application]\nconfig/name="Test Game"\n');
  return directory;
}

function textFrom(response: any): string {
  return response.content.find((item: any) => item.type === 'text').text;
}

describe('GameToolHandlers', () => {
  it('maps camelCase arguments and delegates through the command service', async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const handlers = new GameToolHandlers({
      commands: {
        execute,
        hasActiveProcess: () => true,
        isConnected: () => true,
        readNewErrors: () => [],
        readNewLogs: () => [],
        send: vi.fn(),
      } as any,
    });

    await handlers.handleGameSetProperty({ nodePath: '/root/Player', property: 'speed', value: 4, typeHint: 'float' });

    expect(execute).toHaveBeenCalledWith(
      'set_property',
      { nodePath: '/root/Player', property: 'speed', value: 4, typeHint: 'float' },
      expect.any(Function),
    );
    const buildParams = execute.mock.calls[0][2];
    expect(buildParams({ nodePath: '/root/Player', property: 'speed', value: 4, typeHint: 'float' }))
      .toEqual({ node_path: '/root/Player', property: 'speed', value: 4, type_hint: 'float' });
  });

  it('returns validation errors before sending invalid game commands', async () => {
    const execute = vi.fn();
    const handlers = new GameToolHandlers({ commands: {
      execute,
      hasActiveProcess: () => true,
      isConnected: () => true,
      readNewErrors: () => [],
      readNewLogs: () => [],
      send: vi.fn(),
    } as any });

    const response = await handlers.handleGameGetProperty({ nodePath: '/root/Player' });

    expect(textFrom(response)).toContain('nodePath and property are required');
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns one screenshot preview with bounded digest metadata and optional temp retention', async () => {
    const bytes = Buffer.from('png-fixture');
    const send = vi.fn().mockResolvedValue({
      jsonrpc: '2.0', id: 1,
      result: { data: bytes.toString('base64'), width: 32, height: 18 },
    });
    const handlers = new GameToolHandlers({ commands: {
      execute: vi.fn(), hasActiveProcess: () => true, isConnected: () => true,
      readNewErrors: () => [], readNewLogs: () => [], send,
    } as any });

    const response = await handlers.handleGameScreenshot({ retainArtifact: true });
    const text = JSON.parse(textFrom(response));

    expect(response.content.filter((item: any) => item.type === 'image')).toHaveLength(1);
    expect(text).toMatchObject({ captured: true, width: 32, height: 18, bytes: bytes.length, project_artifact: false });
    expect(text.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(text.artifact_path).toContain(join(tmpdir(), 'godot-agent-loop-artifacts'));
    expect(existsSync(text.artifact_path)).toBe(true);
    expect(JSON.stringify(text)).not.toContain(bytes.toString('base64'));
    rmSync(text.artifact_path, { force: true });
  });
});

describe('ProjectToolHandlers', () => {
  it('lists projects through ProjectSupport and preserves the result shape', async () => {
    const root = createProject();
    const nested = join(root, 'nested');
    mkdirSync(nested);
    writeFileSync(join(nested, 'project.godot'), '');
    const findGodotProjects = vi.fn().mockReturnValue([
      { path: root, name: 'root' },
      { path: nested, name: 'nested' },
    ]);
    const handlers = new ProjectToolHandlers({
      executable: { path: 'godot' } as any,
      logDebug: vi.fn(),
      operations: {} as any,
      projectSupport: { findGodotProjects } as any,
    });

    const response = await handlers.handleListProjects({ directory: root, recursive: true });

    expect(findGodotProjects).toHaveBeenCalledWith(root, true);
    expect(JSON.parse(textFrom(response))).toEqual([
      { path: root, name: 'root' },
      { path: nested, name: 'nested' },
    ]);
  });

  it('executes create_scene with normalized defaults', async () => {
    const root = createProject();
    const execute = vi.fn().mockResolvedValue({ stdout: 'created', stderr: '', exitCode: 0, signal: null });
    const handlers = new ProjectToolHandlers({
      executable: { path: 'godot' } as any,
      logDebug: vi.fn(),
      operations: { execute } as any,
      projectSupport: {} as any,
    });

    const response = await handlers.handleCreateScene({ project_path: root, scene_path: 'main.tscn' });

    expect(execute).toHaveBeenCalledWith('create_scene', {
      scenePath: 'main.tscn',
      rootNodeType: 'Node2D',
    }, root);
    expect(textFrom(response)).toContain('Scene created successfully at: main.tscn');
  });

  it('reports a create_scene process failure from its exit status', async () => {
    const root = createProject();
    const handlers = new ProjectToolHandlers({
      executable: { path: 'godot' } as any,
      logDebug: vi.fn(),
      operations: { execute: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 1, signal: null }) } as any,
      projectSupport: {} as any,
    });

    const response = await handlers.handleCreateScene({ projectPath: root, scenePath: 'main.tscn' });

    expect(response.isError).toBe(true);
    expect(textFrom(response)).toContain('exited with code 1');
  });

  it('rejects unsafe CI generator values without writing a workflow', async () => {
    const root = createProject();
    const handlers = new ProjectToolHandlers({
      executable: { path: 'godot' } as any,
      logDebug: vi.fn(),
      operations: {} as any,
      projectSupport: {} as any,
    });

    const response = await handlers.handleManageCiPipeline({
      projectPath: root, action: 'create', platforms: ['linux', 'linux; rm -rf /'],
    });

    expect(response.isError).toBe(true);
    expect(textFrom(response)).toContain('platforms must be a non-empty array');
    expect(existsSync(join(root, '.github', 'workflows', 'godot-export.yml'))).toBe(false);
  });

  it('rejects unsafe Docker generator values and emits an escaped JSON command', async () => {
    const root = createProject();
    const handlers = new ProjectToolHandlers({
      executable: { path: 'godot' } as any,
      logDebug: vi.fn(),
      operations: {} as any,
      projectSupport: {} as any,
    });

    const invalid = await handlers.handleManageDockerExport({
      projectPath: root, action: 'create', baseImage: 'ubuntu:22.04\nRUN malicious',
    });
    expect(invalid.isError).toBe(true);
    expect(textFrom(invalid)).toContain('baseImage must be one of');
    expect(existsSync(join(root, 'Dockerfile'))).toBe(false);

    const valid = await handlers.handleManageDockerExport({
      projectPath: root, action: 'create', exportPreset: 'Linux/X11', baseImage: 'ubuntu:24.04',
    });
    expect(valid.isError).toBeUndefined();
    expect(textFrom(valid)).toContain('Linux/X11');
    expect(readFileSync(join(root, 'Dockerfile'), 'utf8'))
      .toContain('CMD ["godot", "--headless", "--export-release", "Linux/X11", "build/game"]');
  });
});

describe('LifecycleToolHandlers', () => {
  function context(overrides: Partial<LifecycleToolHandlerContext> = {}): LifecycleToolHandlerContext {
    return {
      executable: { requirePath: vi.fn().mockResolvedValue('godot') } as any,
      getActiveProcess: () => null,
      isPathAllowed: () => true,
      isRelativePathAllowed: () => true,
      logDebug: vi.fn(),
      startProjectProcess: vi.fn(),
      stopProjectProcess: vi.fn(),
      connectToGame: vi.fn().mockResolvedValue(undefined),
      disconnectFromGame: vi.fn(),
      injectInteractionServer: vi.fn(),
      removeInteractionServer: vi.fn(),
      getConnectedProjectPath: () => null,
      clearConnectedProjectPath: vi.fn(),
      getInteractionPort: () => 6007,
      getRuntimeEnvironment: () => ({}),
      isGameConnected: () => false,
      sendGameCommand: vi.fn(),
      ...overrides,
    };
  }

  it('returns captured output from the active process', async () => {
    const process = { output: ['ready'], errors: ['warning'] } as GodotProcess;
    const handlers = new LifecycleToolHandlers(context({ getActiveProcess: () => process }));

    const response = await handlers.handleGetDebugOutput();

    expect(JSON.parse(textFrom(response))).toEqual({ output: ['ready'], errors: ['warning'] });
  });

  it('launches watched runs with realtime display timing by default', async () => {
    const projectPath = createProject();
    const startProjectProcess = vi.fn();
    const handlers = new LifecycleToolHandlers(context({ startProjectProcess }));

    const response = await handlers.handleRunProject({ projectPath });

    expect(response.isError).not.toBe(true);
    expect(startProjectProcess).toHaveBeenCalledOnce();
    expect(startProjectProcess.mock.calls[0][1]).toEqual([
      '--time-scale', '1', '--path', projectPath,
    ]);
    expect(startProjectProcess.mock.calls[0][3]).toEqual({
      GODOT_MCP_FIXED_FPS: '', GODOT_MCP_TIMING_MODE: 'realtime',
    });
    expect(JSON.parse(textFrom(response)).timing_policy).toMatchObject({ mode: 'realtime', fixed_fps: null });
  });

  it('keeps deterministic timing explicit for verification-style runs', async () => {
    const projectPath = createProject();
    const startProjectProcess = vi.fn();
    const handlers = new LifecycleToolHandlers(context({ startProjectProcess }));
    await handlers.handleRunProject({ projectPath, timingMode: 'deterministic' });
    expect(startProjectProcess.mock.calls[0][1]).toEqual([
      '--fixed-fps', '60', '--max-fps', '60', '--time-scale', '1', '--path', projectPath,
    ]);
    expect(startProjectProcess.mock.calls[0][3]).toEqual({
      GODOT_MCP_FIXED_FPS: '60', GODOT_MCP_TIMING_MODE: 'deterministic',
    });
  });

  it('serializes concurrent idempotent editor ensure requests for one project', async () => {
    const projectPath = createProject();
    const ensureEditorSession = vi.fn().mockResolvedValue({
      state: 'connected', project_path: projectPath, connected: true, reused: true, spawned: false,
      editor_pid: 42, editor_start_identity: '42:1', port: 32000, protocol_version: '2',
      addon_version: '1.1.0', godot_version: '4.7', created_at: '1',
    });
    const handlers = new LifecycleToolHandlers(context({ ensureEditorSession }));

    const [first, second] = await Promise.all([
      handlers.handleEditorSession({ projectPath, action: 'ensure' }),
      handlers.handleEditorSession({ projectPath, action: 'ensure' }),
    ]);

    expect(ensureEditorSession).toHaveBeenCalledOnce();
    expect(JSON.parse(textFrom(first)).editor_session).toMatchObject({ connected: true, reused: true });
    expect(textFrom(second)).toBe(textFrom(first));
  });

  it('rejects editor_control scene traversal before dispatching to the editor', async () => {
    const sendEditorCommand = vi.fn();
    const isRelativePathAllowed = vi.fn((_projectPath: string, relativePath: string) => !relativePath.includes('..'));
    const handlers = new LifecycleToolHandlers(context({ isRelativePathAllowed, sendEditorCommand }));

    const response = await handlers.handleEditorControl({
      projectPath: '/project', action: 'open_scene', scenePath: 'res://../outside.tscn',
    });

    expect(response.isError).toBe(true);
    expect(textFrom(response)).toContain('scenePath is outside the project root');
    expect(isRelativePathAllowed).toHaveBeenCalledWith('/project', 'res://../outside.tscn');
    expect(sendEditorCommand).not.toHaveBeenCalled();
  });

  it('rejects editor_transaction scene traversal before inspecting operations', async () => {
    const sendEditorCommand = vi.fn();
    const isRelativePathAllowed = vi.fn((_projectPath: string, relativePath: string) => !relativePath.includes('..'));
    const handlers = new LifecycleToolHandlers(context({ isRelativePathAllowed, sendEditorCommand }));

    const response = await handlers.handleEditorTransaction({
      projectPath: '/project', scenePath: '../outside.tscn', name: 'Unsafe scene',
      operations: [{ op: 'save' }],
    });

    expect(response.isError).toBe(true);
    expect(textFrom(response)).toContain('scenePath is outside the project root');
    expect(isRelativePathAllowed).toHaveBeenCalledWith('/project', '../outside.tscn');
    expect(sendEditorCommand).not.toHaveBeenCalled();
  });

  it('allows safe editor_control and editor_transaction resource paths', async () => {
    const sendEditorCommand = vi.fn().mockResolvedValue({ success: true });
    const isRelativePathAllowed = vi.fn().mockReturnValue(true);
    const handlers = new LifecycleToolHandlers(context({ isRelativePathAllowed, sendEditorCommand }));

    const control = await handlers.handleEditorControl({
      projectPath: '/project', action: 'open_scene', scenePath: 'res://scenes/main.tscn',
    });
    const transaction = await handlers.handleEditorTransaction({
      projectPath: '/project', scenePath: 'scenes/main.tscn', name: 'Safe paths',
      operations: [
        { op: 'instantiate_scene', scenePath: 'res://scenes/enemy.tscn' },
        { op: 'attach_script', scriptPath: 'scripts/player.gd' },
        { op: 'assign_resource', resourcePath: 'res://materials/player.tres' },
      ],
    });

    expect(control.isError).not.toBe(true);
    expect(transaction.isError).not.toBe(true);
    expect(isRelativePathAllowed.mock.calls.map(call => call[1])).toEqual([
      'res://scenes/main.tscn',
      'scenes/main.tscn',
      'res://scenes/enemy.tscn',
      'scripts/player.gd',
      'res://materials/player.tres',
    ]);
    expect(sendEditorCommand).toHaveBeenCalledTimes(2);
  });

  it.each(['scenePath', 'scriptPath', 'resourcePath'])(
    'rejects traversal in editor_transaction operation %s before dispatch',
    async pathKey => {
      const sendEditorCommand = vi.fn();
      const isRelativePathAllowed = vi.fn((_projectPath: string, relativePath: string) => !relativePath.includes('..'));
      const handlers = new LifecycleToolHandlers(context({ isRelativePathAllowed, sendEditorCommand }));

      const response = await handlers.handleEditorTransaction({
        projectPath: '/project', scenePath: 'scenes/main.tscn', name: 'Unsafe path',
        operations: [{ op: 'save', [pathKey]: `res://../outside/${pathKey}` }],
      });

      expect(response.isError).toBe(true);
      expect(textFrom(response)).toContain(`operations[0].${pathKey} is outside the project root`);
      expect(sendEditorCommand).not.toHaveBeenCalled();
    },
  );

  it('waits server-side for a property and returns timeout last-observed evidence', async () => {
    const sendGameCommand = vi.fn().mockResolvedValue({
      jsonrpc: '2.0', id: 1, result: { value: 42 },
    });
    const handlers = new LifecycleToolHandlers(context({ isGameConnected: () => true, sendGameCommand }));

    const matched = await handlers.handleGameWaitUntil({
      condition: 'property', nodePath: '/root/Player', property: 'score', value: 42,
    });
    const timedOut = await new LifecycleToolHandlers(context({ isGameConnected: () => false }))
      .handleGameWaitUntil({ condition: 'connection', timeoutSeconds: 0 });

    expect(JSON.parse(textFrom(matched))).toMatchObject({ satisfied: true, condition: 'property', attempts: 1 });
    expect(sendGameCommand).toHaveBeenCalledWith('get_property', {
      node_path: '/root/Player', property: 'score',
    }, expect.any(Number));
    expect(JSON.parse(textFrom(timedOut))).toMatchObject({
      satisfied: false, condition: 'connection', attempts: 1, last_observed: { connected: false },
    });
    expect(timedOut.isError).toBe(true);
  });

  it('turns an edge-of-deadline poll transport timeout into structured wait evidence', async () => {
    const sendGameCommand = vi.fn()
      .mockResolvedValueOnce({ jsonrpc: '2.0', id: 1, result: { value: 'Anchor' } })
      .mockRejectedValue(new Error("Game request 'godot.runtime.get_property' timed out after 0.001s"));
    const handlers = new LifecycleToolHandlers(context({ isGameConnected: () => true, sendGameCommand }));

    const response = await handlers.handleGameWaitUntil({
      condition: 'property', nodePath: '/root/Main/Anchor', property: 'name', value: 'Never',
      timeoutSeconds: 0.01, pollIntervalMs: 1,
    });

    expect(response.isError).toBe(true);
    expect(JSON.parse(textFrom(response))).toMatchObject({
      satisfied: false, condition: 'property', last_observed: { value: 'Anchor' },
    });
  });

  it('runs a bounded compound scenario and restores time scale without textual image payloads', async () => {
    const sendGameCommand = vi.fn(async (command: string) => {
      if (command === 'screenshot') return { jsonrpc: '2.0', id: 1, result: {
        data: Buffer.from('scenario-png').toString('base64'), width: 64, height: 36,
      } };
      if (command === 'get_performance') return { jsonrpc: '2.0', id: 2, result: { fps: 60 } };
      return { jsonrpc: '2.0', id: 3, result: { time_scale: 1 } };
    });
    const dispatchTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"pressed":true}' }] });
    const handlers = new LifecycleToolHandlers(context({
      isGameConnected: () => true, sendGameCommand, dispatchTool,
    }));

    const response = await handlers.handleGameScenario({ name: 'serve', steps: [
      { type: 'input', tool: 'game_key_press', arguments: { key: 'Space' } },
      { type: 'screenshot' },
      { type: 'performance' },
    ] });
    const evidence = JSON.parse(textFrom(response));

    expect(evidence).toMatchObject({ name: 'serve', passed: true, step_count: 3,
      teardown: { attempted: true, time_scale_restored: true } });
    expect(evidence.steps[1].result).toMatchObject({ captured: true, width: 64, height: 36, preview_omitted: true });
    expect(textFrom(response)).not.toContain(Buffer.from('scenario-png').toString('base64'));
    expect(sendGameCommand).toHaveBeenLastCalledWith('time_scale', { action: 'set', time_scale: 1 }, 2_000);
  });

  it('stops the process and removes its injected interaction server', async () => {
    const process = { output: ['done'], errors: [] } as GodotProcess;
    const stopProjectProcess = vi.fn().mockReturnValue(process);
    const disconnectFromGame = vi.fn();
    const removeInteractionServer = vi.fn();
    const clearConnectedProjectPath = vi.fn();
    const handlers = new LifecycleToolHandlers(context({
      getActiveProcess: () => process,
      stopProjectProcess,
      disconnectFromGame,
      removeInteractionServer,
      clearConnectedProjectPath,
      getConnectedProjectPath: () => '/tmp/test-game',
    }));

    const response = await handlers.handleStopProject();

    expect(disconnectFromGame).toHaveBeenCalledOnce();
    expect(stopProjectProcess).toHaveBeenCalledOnce();
    expect(removeInteractionServer).toHaveBeenCalledWith('/tmp/test-game');
    expect(clearConnectedProjectPath).toHaveBeenCalledOnce();
    expect(JSON.parse(textFrom(response))).toEqual({
      message: 'Godot project stopped', finalOutput: ['done'], finalErrors: [],
    });
  });

  it('ignores a stopped process exit callback after synchronous cleanup', async () => {
    const projectPath = createProject();
    const process = { output: [], errors: [] } as GodotProcess;
    let activeProcess: GodotProcess | null = null;
    let onExit: (() => void) | undefined;
    const disconnectFromGame = vi.fn();
    const removeInteractionServer = vi.fn();
    const clearConnectedProjectPath = vi.fn();
    const handlers = new LifecycleToolHandlers(context({
      getActiveProcess: () => activeProcess,
      startProjectProcess: (_executable, _args, exitCallback) => {
        activeProcess = process;
        onExit = exitCallback;
      },
      stopProjectProcess: () => {
        activeProcess = null;
        return process;
      },
      disconnectFromGame,
      removeInteractionServer,
      clearConnectedProjectPath,
      getConnectedProjectPath: () => projectPath,
    }));

    await handlers.handleRunProject({ projectPath });
    await handlers.handleStopProject();
    disconnectFromGame.mockClear();
    removeInteractionServer.mockClear();
    clearConnectedProjectPath.mockClear();

    onExit?.();

    expect(disconnectFromGame).not.toHaveBeenCalled();
    expect(removeInteractionServer).not.toHaveBeenCalled();
    expect(clearConnectedProjectPath).not.toHaveBeenCalled();
  });
});
