// @test-kind: unit
import { describe, expect, it, vi } from 'vitest';

import { AuthoringSessionManager, AuthoringSessionUnavailableError, RenderingContextUnavailableError } from '../src/authoring-session-manager.js';
import type { GameResponse } from '../src/game-connection.js';
import type { GodotProcessManager, StartGodotProcessOptions } from '../src/godot-process-manager.js';
import type { InteractionServerInstaller } from '../src/interaction-server-installer.js';
import { toolManifest } from '../src/tool-manifest.js';

const backend = toolManifest.create_scene.backend;
if (backend.kind !== 'authoring-session') throw new Error('create_scene backend is not authoring-session');

function fixture(options: { canStart?: () => boolean; renderingContext?: boolean; send?: (command: string, params: Record<string, unknown>) => Promise<GameResponse>; onProjectWrite?: ReturnType<typeof vi.fn> } = {}) {
  const starts: StartGodotProcessOptions[] = [];
  const processManager = {
    active: false,
    start(startOptions: StartGodotProcessOptions) {
      starts.push(startOptions);
      this.active = true;
      return {};
    },
    stop() {
      this.active = false;
      return null;
    },
  };
  const installer = {
    install: vi.fn(() => true),
    remove: vi.fn(),
  };
  const connections: {
    isConnected: boolean;
    supportsCapability: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  }[] = [];
  const manager = new AuthoringSessionManager({
    operationsScriptPath: '/build/scripts/godot_operations.gd',
    resolveGodotPath: async () => '/godot',
    installer: installer as unknown as InteractionServerInstaller,
    processManager: processManager as unknown as GodotProcessManager,
    allocatePort: async () => 23456,
    secretFactory: () => 'test-secret',
    canStart: options.canStart,
    onProjectWrite: options.onProjectWrite,
    createConnection: () => {
      const connection = {
        isConnected: false,
        supportsCapability: vi.fn(() => options.renderingContext !== false),
        connect: vi.fn(async function () { connection.isConnected = true; }),
        disconnect: vi.fn(() => { connection.isConnected = false; }),
        send: vi.fn(options.send ?? (async () => ({
          jsonrpc: '2.0', id: 1, result: { success: true, stdout: 'ok' },
        }))),
      };
      connections.push(connection);
      return connection;
    },
  });
  return { manager, starts, processManager, installer, connections };
}

describe('AuthoringSessionManager', () => {
  it('starts once, reuses the process, and converts params to snake_case', async () => {
    const { manager, starts, connections } = fixture();

    const first = await manager.execute(backend, { scenePath: 'first.tscn' }, '/project');
    const second = await manager.execute(backend, { rootNodeType: 'Node2D' }, '/project');

    expect(first.stdout).toBe('ok');
    expect(second.stdout).toBe('ok');
    expect(starts).toHaveLength(1);
    expect(starts[0].args).toEqual([
      '--fixed-fps', '60', '--max-fps', '60', '--time-scale', '1',
      '--path', '/project', '--script', '/build/scripts/godot_operations.gd', '--serve-authoring',
    ]);
    expect(starts[0].env).toEqual({
      GODOT_MCP_FIXED_FPS: '60',
      GODOT_MCP_TIMING_MODE: 'deterministic',
      GODOT_MCP_RUNTIME_PORT: '23456', GODOT_MCP_RUNTIME_SECRET: 'test-secret',
    });
    expect(connections[0].send).toHaveBeenNthCalledWith(
      1, 'authoring_create_scene', { scene_path: 'first.tscn' }, 30_000,
    );
    expect(connections[0].send).toHaveBeenNthCalledWith(
      2, 'authoring_create_scene', { root_node_type: 'Node2D' }, 30_000,
    );
    manager.stop();
  });

  it('pushes successful mutations to the editor without reporting reads', async () => {
    const onProjectWrite = vi.fn();
    const { manager } = fixture({ onProjectWrite });

    await manager.execute(backend, { scenePath: 'scenes/level.tscn' }, '/project');
    const readBackend = toolManifest.read_scene.backend;
    if (readBackend.kind !== 'authoring-session') throw new Error('read_scene backend mismatch');
    await manager.execute(readBackend, { scenePath: 'scenes/level.tscn' }, '/project');

    expect(onProjectWrite).toHaveBeenCalledOnce();
    expect(onProjectWrite).toHaveBeenCalledWith({
      project_path: '/project', command: 'authoring_create_scene',
      scene_path: 'res://scenes/level.tscn', focus_path: '.',
    });
    manager.stop();
  });

  it('derives the newly added scene node as the editor focus target', async () => {
    const onProjectWrite = vi.fn();
    const { manager } = fixture({ onProjectWrite });
    const addBackend = toolManifest.add_node.backend;
    if (addBackend.kind !== 'authoring-session') throw new Error('add_node backend mismatch');

    await manager.execute(addBackend, {
      scenePath: 'main.tscn', parentNodePath: 'root/Actors', nodeName: 'Player',
    }, '/project');

    expect(onProjectWrite).toHaveBeenCalledWith(expect.objectContaining({
      scene_path: 'res://main.tscn', focus_path: 'Actors/Player',
    }));
    manager.stop();
  });

  it('serializes commands so the single-request Godot transport is never busy', async () => {
    let active = 0;
    let maximum = 0;
    const { manager } = fixture({
      send: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active -= 1;
        return { jsonrpc: '2.0', id: 1, result: { success: true, stdout: 'ok' } };
      },
    });

    await Promise.all([
      manager.execute(backend, {}, '/project'),
      manager.execute(backend, {}, '/project'),
      manager.execute(backend, {}, '/project'),
    ]);

    expect(maximum).toBe(1);
    manager.stop();
  });

  it('switches projects with deterministic disconnect and installation cleanup', async () => {
    const { manager, starts, installer, connections } = fixture();
    await manager.execute(backend, {}, '/first');
    await manager.execute(backend, {}, '/second');

    expect(starts).toHaveLength(2);
    expect(connections[0].disconnect).toHaveBeenCalledOnce();
    expect(installer.remove).toHaveBeenCalledWith('/first', true);
    expect(manager.activeProjectPath).toBe('/second');
    manager.stop();
    expect(installer.remove).toHaveBeenCalledWith('/second', true);
  });

  it('reports startup unavailability before installing or dispatching', async () => {
    const { manager, installer } = fixture({ canStart: () => false });

    await expect(manager.execute(backend, {}, '/project'))
      .rejects.toBeInstanceOf(AuthoringSessionUnavailableError);
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('fails fast and cleans up when a headed rendering context is unavailable', async () => {
    const { manager, installer, connections } = fixture({ renderingContext: false });

    await expect(manager.execute(backend, {}, '/project'))
      .rejects.toThrow(RenderingContextUnavailableError);
    expect(connections[0].supportsCapability).toHaveBeenCalledWith('rendering-context');
    expect(connections[0].disconnect).toHaveBeenCalledOnce();
    expect(installer.remove).toHaveBeenCalledWith('/project', true);
  });

  it('returns command failures without throwing a fallback-safe startup error', async () => {
    const { manager } = fixture({
      send: async () => ({
        jsonrpc: '2.0', id: 1,
        error: { code: -32000, message: 'invalid scene', data: { reason: 'authoring_operation_failed' } },
      }),
    });

    const result = await manager.execute(backend, {}, '/project');
    expect(result).toMatchObject({ exitCode: 1, signal: null });
    expect(result.stderr).toContain('authoring_operation_failed');
    manager.stop();
  });

  it('returns a handled editor operation without starting the authoring process', async () => {
    const result = { stdout: 'editor', stderr: '', exitCode: 0, signal: null };
    const starts: StartGodotProcessOptions[] = [];
    const processManager = {
      active: false,
      start(options: StartGodotProcessOptions) { starts.push(options); return {}; },
      stop() { return null; },
    };
    const manager = new AuthoringSessionManager({
      operationsScriptPath: '/operations.gd',
      resolveGodotPath: async () => '/godot',
      installer: { install: vi.fn(), remove: vi.fn() } as unknown as InteractionServerInstaller,
      processManager: processManager as unknown as GodotProcessManager,
      tryEditorOperation: vi.fn(async () => ({ handled: true, result })),
    });

    await expect(manager.execute(backend, { scenePath: 'main.tscn' }, '/project')).resolves.toEqual(result);
    expect(starts).toHaveLength(0);
  });
});
