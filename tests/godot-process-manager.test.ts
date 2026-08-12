// @test-kind: unit
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GODOT_MCP_CHILD_ENV_ALLOW } from '../src/godot-child-environment.js';
import { GodotProcessManager } from '../src/godot-process-manager.js';
import {
  GODOT_COMMAND_MAX_BUFFER_BYTES,
  GODOT_COMMAND_OPTIONS,
  GODOT_COMMAND_TIMEOUT_MS,
  GODOT_EXPORT_OPTIONS,
  GODOT_EXPORT_TIMEOUT_MS,
  GODOT_VERSION_OPTIONS,
  GODOT_VERSION_TIMEOUT_MS,
} from '../src/godot-subprocess.js';

type Listener = (...args: any[]) => void;

const TEST_LEAK_VARIABLE = 'GODOT_MCP_TEST_SHOULD_NOT_LEAK';
const TEST_OPT_IN_VARIABLE = 'GODOT_MCP_TEST_OPT_IN';

function withEnvironment(entries: Record<string, string | undefined>, run: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- process.env requires literal deletion; assignment stringifies undefined.
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- process.env requires literal deletion; assignment stringifies undefined.
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function createChild() {
  const listeners = new Map<string, Listener[]>();
  const on = vi.fn((event: string, listener: Listener) => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    return child;
  });
  const child = {
    on,
    kill: vi.fn(),
    stdout: { on: vi.fn((event: string, listener: Listener) => { listeners.set(`stdout:${event}`, [listener]); }) },
    stderr: { on: vi.fn((event: string, listener: Listener) => { listeners.set(`stderr:${event}`, [listener]); }) },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
    emitOutput(stream: 'stdout' | 'stderr', value: string) {
      for (const listener of listeners.get(`${stream}:data`) ?? []) listener(Buffer.from(value));
    },
  };
  return child;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('GodotProcessManager', () => {
  it('defines bounded output and timeouts for every short-lived Godot subprocess class', () => {
    expect(GODOT_COMMAND_OPTIONS).toMatchObject({ timeout: GODOT_COMMAND_TIMEOUT_MS, maxBuffer: GODOT_COMMAND_MAX_BUFFER_BYTES });
    expect(GODOT_VERSION_OPTIONS).toMatchObject({ timeout: GODOT_VERSION_TIMEOUT_MS, maxBuffer: GODOT_COMMAND_MAX_BUFFER_BYTES });
    expect(GODOT_EXPORT_OPTIONS).toMatchObject({ timeout: GODOT_EXPORT_TIMEOUT_MS, maxBuffer: GODOT_COMMAND_MAX_BUFFER_BYTES });
  });

  it('retains only the configured number of recent stdout and stderr lines', () => {
    const child = createChild();
    const manager = new GodotProcessManager(undefined, 3, undefined, () => child as any);
    const record = manager.start({ executable: 'godot', args: [] });

    child.emitOutput('stdout', 'one\ntwo\nthree\nfour');
    child.emitOutput('stderr', 'a\nb\nc\nd');

    expect(record.output).toEqual(['two', 'three', 'four']);
    expect(record.errors).toEqual(['b', 'c', 'd']);
  });

  it('pages unread output without skipping lines and keeps cursors valid after retention trimming', () => {
    const child = createChild();
    const manager = new GodotProcessManager(undefined, 4, undefined, () => child as any);
    manager.start({ executable: 'godot', args: [] });

    child.emitOutput('stdout', 'one\ntwo\nthree');
    expect(manager.readNewLogs(2)).toEqual({ items: ['one', 'two'], remaining: 1, byteLimited: false });
    child.emitOutput('stdout', 'four\nfive');
    expect(manager.readNewLogs(2)).toEqual({ items: ['three', 'four'], remaining: 1, byteLimited: false });
    expect(manager.readNewLogs(2)).toEqual({ items: ['five'], remaining: 0, byteLimited: false });

    child.emitOutput('stderr', 'a\nb\nc');
    expect(manager.readNewErrors(1)).toEqual({ items: ['a'], remaining: 2, byteLimited: false });
    child.emitOutput('stderr', 'd\ne');
    expect(manager.readNewErrors(3)).toEqual({ items: ['b', 'c', 'd'], remaining: 1, byteLimited: false });
    expect(manager.readNewErrors(3)).toEqual({ items: ['e'], remaining: 0, byteLimited: false });
  });

  it('bounds cursor pages by bytes without skipping unread lines', () => {
    const child = createChild();
    const manager = new GodotProcessManager(undefined, 10, undefined, () => child as any);
    manager.start({ executable: 'godot', args: [] });

    child.emitOutput('stdout', `${'a'.repeat(40)}\n${'b'.repeat(40)}\n${'c'.repeat(40)}`);
    expect(manager.readNewLogs(10, 90)).toEqual({
      items: ['a'.repeat(40), 'b'.repeat(40)], remaining: 1, byteLimited: true,
    });
    expect(manager.readNewLogs(10, 90)).toEqual({
      items: ['c'.repeat(40)], remaining: 0, byteLimited: false,
    });
  });

  it('clips pathological individual lines and reports retention loss', () => {
    const child = createChild();
    const manager = new GodotProcessManager(undefined, 3, undefined, () => child as any);
    const record = manager.start({ executable: 'godot', args: [] });

    child.emitOutput('stderr', 'x'.repeat(70 * 1024));
    expect(Buffer.byteLength(record.errors[0], 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(record.errors[0]).toContain('[truncated at 65536 bytes]');
    child.emitOutput('stderr', 'second\nthird\nfour');
    expect(record.errors).toEqual(['second', 'third', 'four']);
    expect(record.errorsDropped).toBe(1);
  });

  it('passes runtime authentication only through the child environment', () => {
    const child = createChild();
    const spawnProcess = vi.fn(() => child as any);
    const manager = new GodotProcessManager(undefined, 3, undefined, spawnProcess as any);
    manager.start({
      executable: 'godot', args: ['--path', '/project'],
      env: { GODOT_MCP_RUNTIME_SECRET: 'child-only-secret' },
    });

    expect(spawnProcess).toHaveBeenCalledWith('godot', ['--path', '/project'], {
      stdio: 'pipe',
      env: expect.objectContaining({ GODOT_MCP_RUNTIME_SECRET: 'child-only-secret' }),
    });
  });

  it('spawns Godot with only an allowlisted environment by default', () => {
    withEnvironment({ [TEST_LEAK_VARIABLE]: 'top-secret' }, () => {
      const child = createChild();
      const spawnProcess = vi.fn(() => child as any);
      // Constructor order: (log, logLineLimit, gracefulShutdownTimeoutMs, spawnProcess, additionalEnvironmentKeys).
      const manager = new GodotProcessManager(undefined, 3, undefined, spawnProcess as any);
      manager.start({ executable: 'godot', args: [] });

      expect(spawnProcess).toHaveBeenCalledTimes(1);
      const spawnedEnv = (spawnProcess.mock.calls[0][2] as { env: NodeJS.ProcessEnv }).env;
      expect(spawnedEnv[TEST_LEAK_VARIABLE]).toBeUndefined();
      expect(spawnedEnv.PATH).toBe(process.env.PATH);
      if (process.env.HOME !== undefined) expect(spawnedEnv.HOME).toBe(process.env.HOME);
    });
  });

  it('forwards only the documented opt-in variables when GODOT_MCP_CHILD_ENV_ALLOW is set', () => {
    withEnvironment({
      [GODOT_MCP_CHILD_ENV_ALLOW]: `${TEST_OPT_IN_VARIABLE}, NO_SUCH_VARIABLE`,
      [TEST_OPT_IN_VARIABLE]: '/run/user/1000/agent.sock',
      [TEST_LEAK_VARIABLE]: 'top-secret',
    }, () => {
      const child = createChild();
      const spawnProcess = vi.fn(() => child as any);
      const manager = new GodotProcessManager(undefined, 3, undefined, spawnProcess as any);
      manager.start({ executable: 'godot', args: [] });

      expect(spawnProcess).toHaveBeenCalledTimes(1);
      const spawnedEnv = (spawnProcess.mock.calls[0][2] as { env: NodeJS.ProcessEnv }).env;
      expect(spawnedEnv[TEST_OPT_IN_VARIABLE]).toBe('/run/user/1000/agent.sock');
      expect(spawnedEnv[TEST_LEAK_VARIABLE]).toBeUndefined();
    });
  });

  it('honors an explicit allowlist supplied to the manager', () => {
    withEnvironment({ [TEST_OPT_IN_VARIABLE]: 'explicit-allowlist' }, () => {
      const child = createChild();
      const spawnProcess = vi.fn(() => child as any);
      const manager = new GodotProcessManager(
        undefined, 3, undefined, spawnProcess as any, new Set([TEST_OPT_IN_VARIABLE]),
      );
      manager.start({ executable: 'godot', args: [] });

      expect(spawnProcess).toHaveBeenCalledTimes(1);
      const spawnedEnv = (spawnProcess.mock.calls[0][2] as { env: NodeJS.ProcessEnv }).env;
      expect(spawnedEnv[TEST_OPT_IN_VARIABLE]).toBe('explicit-allowlist');
    });
  });

  it('always forwards the explicit per-launch environment over the allowlist', () => {
    withEnvironment({ [TEST_LEAK_VARIABLE]: 'top-secret' }, () => {
      const child = createChild();
      const spawnProcess = vi.fn(() => child as any);
      const manager = new GodotProcessManager(undefined, 3, undefined, spawnProcess as any);
      manager.start({
        executable: 'godot',
        args: [],
        env: { GODOT_MCP_RUNTIME_SECRET: 'child-only-secret', PATH: '/custom/bin' },
      });

      expect(spawnProcess).toHaveBeenCalledTimes(1);
      const spawnedEnv = (spawnProcess.mock.calls[0][2] as { env: NodeJS.ProcessEnv }).env;
      expect(spawnedEnv.PATH).toBe('/custom/bin');
      expect(spawnedEnv.GODOT_MCP_RUNTIME_SECRET).toBe('child-only-secret');
      expect(spawnedEnv[TEST_LEAK_VARIABLE]).toBeUndefined();
    });
  });

  it('sends SIGTERM first, then SIGKILL when the process does not exit', () => {
    vi.useFakeTimers();
    const child = createChild();
    const manager = new GodotProcessManager(undefined, 10, 100, () => child as any);
    manager.start({ executable: 'godot', args: [] });

    manager.stop();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    vi.advanceTimersByTime(100);
    expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
  });

  it('does not force-kill a process that exits during graceful shutdown', () => {
    vi.useFakeTimers();
    const child = createChild();
    const manager = new GodotProcessManager(undefined, 10, 100, () => child as any);
    manager.start({ executable: 'godot', args: [] });

    manager.stop();
    child.emit('exit', 0);
    vi.advanceTimersByTime(100);

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
