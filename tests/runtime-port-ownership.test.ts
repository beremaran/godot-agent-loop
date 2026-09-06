// @test-kind: unit
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RUNTIME_PORT_ENVIRONMENT_VARIABLE,
  RuntimePortOwnershipError,
  assertRuntimePortAvailable,
  findRuntimePortOwnershipFailure,
  isRuntimePortOwnershipError,
} from '../src/runtime-port.js';
import type { LifecycleToolHandlerContext } from '../src/tool-handlers/lifecycle-tool-handlers.js';
import { LifecycleToolHandlers } from '../src/tool-handlers/lifecycle-tool-handlers.js';
import type { GodotProcess } from '../src/godot-process-manager.js';

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    on: vi.fn(),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    kill: vi.fn(),
  })),
}));

const tempRoots: string[] = [];

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'godot-agent-loop-port-ownership-'));
  writeFileSync(join(root, 'project.godot'), '[application]\nconfig/name="test"\n');
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function allocateFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a port'));
        return;
      }
      const port = address.port;
      server.close(() => { resolve(port); });
    });
  });
}

async function occupyPort(port: number) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { resolve(); });
  });
  return server;
}

function createContext(selectedPort: number, overrides: Partial<LifecycleToolHandlerContext> = {}): {
  context: LifecycleToolHandlerContext;
  started: boolean[];
  connected: boolean[];
  stopped: boolean[];
  disconnected: boolean[];
} {
  const started: boolean[] = [];
  const connected: boolean[] = [];
  const stopped: boolean[] = [];
  const disconnected: boolean[] = [];
  const context: LifecycleToolHandlerContext = {
    executable: { requirePath: vi.fn().mockResolvedValue('/mock/godot') } as never,
    getActiveProcess: () => null,
    isPathAllowed: () => true,
    isRelativePathAllowed: () => true,
    isHeadless: () => false,
    logDebug: () => undefined,
    startProjectProcess: () => {
      started.push(true);
      const record: GodotProcess = { process: {} as never, output: [], errors: [] };
      return record;
    },
    stopProjectProcess: () => {
      stopped.push(true);
      return null;
    },
    connectToGame: () => {
      connected.push(true);
      return Promise.resolve();
    },
    disconnectFromGame: () => {
      disconnected.push(true);
    },
    injectInteractionServer: () => undefined,
    removeInteractionServer: () => undefined,
    getConnectedProjectPath: () => null,
    clearConnectedProjectPath: () => undefined,
    getInteractionPort: () => selectedPort,
    getRuntimeHandshake: () => null,
    getRuntimeEnvironment: () => ({ GODOT_MCP_RUNTIME_PORT: String(selectedPort) }),
    isGameConnected: () => false,
    sendGameCommand: () => Promise.resolve({ result: { current_scene: null } }),
    ...overrides,
  };
  return { context, started, connected, stopped, disconnected };
}

describe('runtime port ownership', () => {
  it('reports an ownership diagnostic for the selected port', () => {
    const error = new RuntimePortOwnershipError(54321);
    expect(error.port).toBe(54321);
    expect(error.message).toContain(`${RUNTIME_PORT_ENVIRONMENT_VARIABLE}=54321`);
    expect(error.message).toMatch(/already owned/);
    expect(isRuntimePortOwnershipError(error)).toBe(true);
    expect(isRuntimePortOwnershipError(new Error('other'))).toBe(false);
  });

  it('detects the runtime bind failure naming the selected port', () => {
    const output = `McpInteractionServer: Failed to listen on port 54321, error: 1; port is already owned by another process.`;
    expect(findRuntimePortOwnershipFailure(output, 54321)).toContain('54321');
    expect(findRuntimePortOwnershipFailure('Listening on 127.0.0.1:54321', 54321)).toBeNull();
    expect(findRuntimePortOwnershipFailure(output, 54322)).toBeNull();
  });

  it('fails an occupied selected port immediately without spawning or connecting', async () => {
    const selectedPort = await allocateFreePort();
    const owner = await occupyPort(selectedPort);
    try {
      await expect(assertRuntimePortAvailable(selectedPort)).rejects.toBeInstanceOf(RuntimePortOwnershipError);

      const projectPath = tempProject();
      const { context, started, connected } = createContext(selectedPort);
      const handlers = new LifecycleToolHandlers(context);
      const startedAt = Date.now();
      const response = await handlers.handleRunProject({ projectPath });
      const elapsedMs = Date.now() - startedAt;

      expect(response.isError).toBe(true);
      const text = response.content.map(item => ('text' in item ? item.text : '')).join('\n');
      expect(text).toContain(String(selectedPort));
      expect(text).toMatch(/already owned/);
      // Never spawned a runtime and never continued against the unrelated owner.
      expect(started).toHaveLength(0);
      expect(connected).toHaveLength(0);
      // Prompt failure rather than the ~90s connection retry window.
      expect(elapsedMs).toBeLessThan(10_000);
    } finally {
      await new Promise<void>(resolve => { owner.close(() => { resolve(); }); });
    }
  });

  it('terminates the runtime promptly when the child reports a bind failure', async () => {
    const selectedPort = await allocateFreePort();
    const projectPath = tempProject();
    let record: GodotProcess | null = null;
    const { context } = createContext(selectedPort, {
      startProjectProcess: () => {
        record = { process: { exitCode: null, signalCode: null } as never, output: [], errors: [] };
        // The real engine prints the bind diagnostic shortly after launch.
        setTimeout(() => {
          record?.errors.push(
            `ERROR: McpInteractionServer: Failed to listen on port ${selectedPort}, error: 1; port is already owned by another process.`,
          );
        }, 20);
        return record;
      },
      // Hang the connection attempt so only the ownership watcher can end the race.
      connectToGame: (_projectPath: string, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        signal?.addEventListener('abort', () => { reject(new Error('aborted')); }, { once: true });
      }),
      stopProjectProcess: vi.fn(() => null),
      disconnectFromGame: vi.fn(),
      removeInteractionServer: vi.fn(),
    });
    const stopSpy = context.stopProjectProcess as ReturnType<typeof vi.fn>;
    const disconnectSpy = context.disconnectFromGame as ReturnType<typeof vi.fn>;

    const handlers = new LifecycleToolHandlers(context);
    const startedAt = Date.now();
    const response = await handlers.handleRunProject({ projectPath });
    const elapsedMs = Date.now() - startedAt;

    expect(response.isError).toBe(true);
    const text = response.content.map(item => ('text' in item ? item.text : '')).join('\n');
    expect(text).toContain(String(selectedPort));
    expect(text).toMatch(/already owned/);
    // The runtime and the run are terminated promptly; no success is reported.
    expect(stopSpy).toHaveBeenCalled();
    expect(disconnectSpy).toHaveBeenCalled();
    expect(elapsedMs).toBeLessThan(10_000);
  });
});
