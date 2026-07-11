import { afterEach, describe, expect, it, vi } from 'vitest';

import { GodotProcessManager } from '../src/godot-process-manager.js';

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
