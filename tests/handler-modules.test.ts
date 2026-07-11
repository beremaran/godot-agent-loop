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
  const directory = mkdtempSync(join(tmpdir(), 'godot-mcp-handler-'));
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
      ...overrides,
    };
  }

  it('returns captured output from the active process', async () => {
    const process = { output: ['ready'], errors: ['warning'] } as GodotProcess;
    const handlers = new LifecycleToolHandlers(context({ getActiveProcess: () => process }));

    const response = await handlers.handleGetDebugOutput();

    expect(JSON.parse(textFrom(response))).toEqual({ output: ['ready'], errors: ['warning'] });
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
});
