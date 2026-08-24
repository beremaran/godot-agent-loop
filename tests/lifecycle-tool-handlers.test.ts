// @test-kind: unit
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LifecycleToolHandlerContext } from '../src/tool-handlers/lifecycle-tool-handlers.js';
import { LifecycleToolHandlers } from '../src/tool-handlers/lifecycle-tool-handlers.js';
import type { GodotProcess } from '../src/godot-process-manager.js';

vi.mock('child_process', () => {
  return {
    spawn: vi.fn(() => ({
      on: vi.fn(),
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      kill: vi.fn(),
    })),
  };
});

const tempRoots: string[] = [];

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'godot-agent-loop-headless-'));
  writeFileSync(join(root, 'project.godot'), '[application]\nconfig/name="test"\n');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface CapturedLaunch {
  args: string[];
  env: NodeJS.ProcessEnv;
}

function createContext(overrides: Partial<LifecycleToolHandlerContext> = {}): {
  context: LifecycleToolHandlerContext;
  captures: CapturedLaunch[];
} {
  const captures: CapturedLaunch[] = [];
  const runtimeEnvironment: NodeJS.ProcessEnv = {
    GODOT_MCP_RUNTIME_SECRET: 'child-only-secret',
    GODOT_MCP_RUNTIME_PORT: '9090',
  };
  const context: LifecycleToolHandlerContext = {
    executable: { requirePath: vi.fn().mockResolvedValue('/mock/godot') } as never,
    getActiveProcess: () => null,
    isPathAllowed: () => true,
    isRelativePathAllowed: () => true,
    isHeadless: () => false,
    logDebug: () => undefined,
    startProjectProcess: (executable, args, _onExit, env) => {
      captures.push({ args, env: env ?? {} });
      const record: GodotProcess = { process: {} as never, output: [], errors: [] };
      return record;
    },
    stopProjectProcess: () => null,
    connectToGame: () => Promise.resolve(),
    disconnectFromGame: () => undefined,
    injectInteractionServer: () => undefined,
    removeInteractionServer: () => undefined,
    getConnectedProjectPath: () => null,
    clearConnectedProjectPath: () => undefined,
    getInteractionPort: () => 9090,
    getRuntimeHandshake: () => null,
    getRuntimeEnvironment: () => runtimeEnvironment,
    isGameConnected: () => false,
    sendGameCommand: () => Promise.resolve({ result: { current_scene: null } }),
    ...overrides,
  };
  return { context, captures };
}

describe('LifecycleToolHandlers headless propagation', () => {
  it('passes --headless through run_project args when GODOT_MCP_HEADLESS is enabled', async () => {
    const projectPath = tempProject();
    const { context, captures } = createContext({ isHeadless: () => true });
    const handlers = new LifecycleToolHandlers(context);
    const response = await handlers.handleRunProject({ projectPath });
    expect(response.isError).not.toBe(true);
    expect(captures[0].args).toContain('--headless');
    expect(captures[0].args).toContain('--path');
  });

  it('omits --headless from run_project args when GODOT_MCP_HEADLESS is disabled', async () => {
    const projectPath = tempProject();
    const { context, captures } = createContext({ isHeadless: () => false });
    const handlers = new LifecycleToolHandlers(context);
    const response = await handlers.handleRunProject({ projectPath });
    expect(response.isError).not.toBe(true);
    expect(captures[0].args).not.toContain('--headless');
  });

  it('propagates headless mode via args, not by leaking GODOT_MCP_HEADLESS into the child', async () => {
    const projectPath = tempProject();
    const { context, captures } = createContext({ isHeadless: () => true });
    const handlers = new LifecycleToolHandlers(context);
    await handlers.handleRunProject({ projectPath });
    expect(captures[0].env.GODOT_MCP_HEADLESS).toBeUndefined();
    expect(captures[0].env.GODOT_MCP_RUNTIME_SECRET).toBe('child-only-secret');
  });

  it('passes --headless to editor launches when GODOT_MCP_HEADLESS is enabled', async () => {
    const projectPath = tempProject();
    const spawnMock = (await import('child_process')).spawn as ReturnType<typeof vi.fn>;
    let calls = 0;
    const { context } = createContext({
      isHeadless: () => true,
      installEditorPlugin: () => ({ pluginName: 'mock', owned: false, distribution: 'local' }) as never,
      ensureEditorSession: () => Promise.resolve(++calls === 1
        ? { connected: false, state: 'no_editor', project_path: projectPath, reused: false, spawned: false, port: null }
        : { connected: true, state: 'connected', project_path: projectPath, reused: false, spawned: false, port: 9090 }),
      getEditorEnvironment: () => ({ GODOT_MCP_EDITOR_START_PAUSED: 'false' }),
    });
    const handlers = new LifecycleToolHandlers(context);
    const response = await handlers.handleEditorSession({ projectPath, action: 'ensure', launchIfNeeded: true });
    expect(response.isError).not.toBe(true);
    const editorArgs = spawnMock.mock.calls[0][1] as string[];
    expect(editorArgs).toContain('-e');
    expect(editorArgs).toContain('--headless');
    const editorEnv = (spawnMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv }).env;
    expect(editorEnv.GODOT_MCP_HEADLESS).toBeUndefined();
    expect(editorEnv.GODOT_MCP_EDITOR_START_PAUSED).toBe('false');
  });
});

describe('LifecycleToolHandlers scene preflight', () => {
  it.each([
    ['missing', 'scenes/missing.tscn'],
    ['traversal', '../outside.tscn'],
    ['outside root', '/outside.tscn'],
  ])('rejects %s scenes before stopping the active project', async (_case, scene) => {
    const projectPath = tempProject();
    const stopProjectProcess = vi.fn(() => null);
    const { context, captures } = createContext({
      getActiveProcess: () => ({ process: {} as never, output: [], errors: [] }),
      stopProjectProcess,
    });
    const handlers = new LifecycleToolHandlers(context);

    const response = await handlers.handleRunProject({ projectPath, scene });

    expect(response.isError).toBe(true);
    expect(stopProjectProcess).not.toHaveBeenCalled();
    expect(captures).toHaveLength(0);
  });
});
