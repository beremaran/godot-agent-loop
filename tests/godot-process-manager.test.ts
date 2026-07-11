import { afterEach, describe, expect, it, vi } from 'vitest';

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
