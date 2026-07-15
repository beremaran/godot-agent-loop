// @test-kind: unit
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorRequestTimeoutError, type EditorConnection } from '../src/editor-connection.js';
import {
  EDITOR_SESSION_DIRECTORY,
  EDITOR_SESSION_FILE,
  EditorSessionRegistry,
  readDiscoveryRecord,
  type EditorSessionDiscoveryRecord,
} from '../src/editor-session-registry.js';

const projects: string[] = [];

function project(name = 'project'): string {
  const path = join(tmpdir(), `godot-editor-session-${process.pid}-${name}-${projects.length}`);
  mkdirSync(join(path, EDITOR_SESSION_DIRECTORY), { recursive: true });
  writeFileSync(join(path, 'project.godot'), '[application]\nconfig/name="test"\n');
  projects.push(path);
  return path;
}

function record(projectPath: string, overrides: Partial<EditorSessionDiscoveryRecord> = {}): EditorSessionDiscoveryRecord {
  let canonical = projectPath;
  try { canonical = realpathSync.native(projectPath); } catch { /* invalid path cases intentionally stay unresolved */ }
  return {
    project_path: canonical,
    editor_pid: process.pid,
    editor_start_identity: 'pid-start-1',
    port: 32123,
    token: 'a'.repeat(43),
    protocol_version: '2',
    addon_version: '1.1.1',
    godot_version: '4.7',
    created_at: '2026-07-15T00:00:00Z',
    ...overrides,
  };
}

function writeRecord(projectPath: string, value: unknown, mode = 0o600): void {
  const path = join(projectPath, EDITOR_SESSION_FILE);
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode });
  chmodSync(path, mode);
}

afterEach(() => {
  for (const path of projects.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('editor session discovery', () => {
  it('validates a private, live, matching discovery record', () => {
    const path = project();
    writeRecord(path, record(path));
    const result = readDiscoveryRecord(path, () => true);
    expect('record' in result && result.record).toMatchObject({ project_path: realpathSync.native(path), protocol_version: '2' });
  });

  it('rejects and removes malformed, stale, cross-project, and insecure records', () => {
    const cases: [string, unknown, number, (pid: number) => boolean][] = [
      ['malformed', { nope: true }, 0o600, () => true],
      ['stale', record('/unused', { project_path: '' }), 0o600, () => false],
      ['cross', record('/somewhere-else'), 0o600, () => true],
      ['insecure', record('/unused', { project_path: '' }), 0o644, () => true],
    ];
    for (const [name, value, mode, pidExists] of cases) {
      const path = project(name);
      const payload = name === 'stale' || name === 'insecure' ? record(path) : value;
      writeRecord(path, payload, mode);
      const result = readDiscoveryRecord(path, pidExists);
      expect('state' in result && ['no_editor', 'addon_missing_restart_required'].includes(result.state)).toBe(true);
      expect(() => readDiscoveryRecord(path, pidExists)).not.toThrow();
    }
  });

  it('distinguishes missing, disabled, outdated, and enabled-without-editor addons', () => {
    const missing = project('missing-addon');
    expect(readDiscoveryRecord(missing)).toMatchObject({ state: 'addon_missing_restart_required' });

    const disabled = project('disabled-addon');
    mkdirSync(join(disabled, 'addons', 'godot_agent_loop'), { recursive: true });
    writeFileSync(join(disabled, 'addons', 'godot_agent_loop', 'plugin.cfg'), 'protocol_version="2"\n');
    expect(readDiscoveryRecord(disabled)).toMatchObject({
      state: 'addon_missing_restart_required', reason: expect.stringContaining('disabled'),
    });

    const outdated = project('outdated-addon');
    mkdirSync(join(outdated, 'addons', 'godot_agent_loop'), { recursive: true });
    writeFileSync(join(outdated, 'addons', 'godot_agent_loop', 'plugin.cfg'), 'protocol_version="1"\n');
    expect(readDiscoveryRecord(outdated)).toMatchObject({ state: 'addon_upgrade_restart_required' });

    const idle = project('enabled-addon');
    mkdirSync(join(idle, 'addons', 'godot_agent_loop'), { recursive: true });
    writeFileSync(join(idle, 'addons', 'godot_agent_loop', 'plugin.cfg'), 'protocol_version="2"\n');
    writeFileSync(join(idle, 'project.godot'), [
      '[editor_plugins]', '',
      'enabled=PackedStringArray("res://addons/godot_agent_loop/plugin.cfg")', '',
    ].join('\n'));
    expect(readDiscoveryRecord(idle)).toMatchObject({ state: 'no_editor' });
  });

  it('reports protocol incompatibility without returning the token', () => {
    const path = project();
    writeRecord(path, record(path, { protocol_version: '1', token: 'secret'.repeat(8) }));
    const result = readDiscoveryRecord(path, () => true);
    expect('state' in result && result.state).toBe('protocol_incompatible');
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});

describe('EditorSessionRegistry', () => {
  it('routes projects through distinct authenticated connections and redacts credentials', async () => {
    const first = project('first');
    const second = project('second');
    writeRecord(first, record(first, { port: 31001, token: 'a'.repeat(43), editor_start_identity: 'first' }));
    writeRecord(second, record(second, { port: 31002, token: 'b'.repeat(43), editor_start_identity: 'second' }));
    const calls: { port: number; command: string }[] = [];
    const registry = new EditorSessionRegistry({
      serverVersion: 'test',
      processExists: () => true,
      retryDelaysMs: [0],
      connectionFactory: discovery => {
        const authenticate = vi.fn(async () => {
          calls.push({ port: discovery.port, command: 'handshake' });
          return {
            success: true,
            project_path: discovery.project_path,
            editor_pid: discovery.editor_pid,
            editor_start_identity: discovery.editor_start_identity,
            protocol_version: discovery.protocol_version,
          };
        });
        return ({
        authenticate,
        send: vi.fn(async (command: string) => {
          calls.push({ port: discovery.port, command });
          return { success: true, project_path: discovery.project_path };
        }),
        disconnect: vi.fn(),
      } as unknown as EditorConnection); },
    });
    expect((await registry.send(first, 'inspect')).project_path).toBe(realpathSync.native(first));
    expect((await registry.send(second, 'inspect')).project_path).toBe(realpathSync.native(second));
    expect(calls.filter(call => call.command === 'inspect')).toEqual([
      { port: 31001, command: 'inspect' },
      { port: 31002, command: 'inspect' },
    ]);
    expect(JSON.stringify(await registry.status(first))).not.toContain('a'.repeat(43));
    registry.disconnectAll();
  });

  it('rejects a handshake whose PID/start identity does not match the discovery record', async () => {
    const path = project();
    writeRecord(path, record(path));
    const registry = new EditorSessionRegistry({
      serverVersion: 'test', processExists: () => true, retryDelaysMs: [0],
      connectionFactory: () => ({
        authenticate: vi.fn(async () => ({ project_path: realpathSync.native(path), editor_pid: process.pid, editor_start_identity: 'different' })),
        send: vi.fn(),
        disconnect: vi.fn(),
      } as unknown as EditorConnection),
    });
    const status = await registry.status(path);
    expect(status.state).toBe('no_editor');
    expect(status.reason).toContain('identity');
    registry.disconnectAll();
  });

  it('reuses a live connection and disconnects only the selected project', async () => {
    const path = project();
    writeRecord(path, record(path));
    const authenticate = vi.fn(async () => ({
      project_path: realpathSync.native(path), editor_pid: process.pid, editor_start_identity: 'pid-start-1',
    }));
    const send = vi.fn(async () => ({ success: true }));
    const disconnect = vi.fn();
    const registry = new EditorSessionRegistry({
      serverVersion: 'test', processExists: () => true,
      connectionFactory: () => ({ authenticate, send, disconnect } as unknown as EditorConnection),
    });
    expect((await registry.ensure(path, 0)).connected).toBe(true);
    expect((await registry.ensure(path, 0)).reused).toBe(true);
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(registry.disconnect(path).state).toBe('no_editor');
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('keeps an authenticated connection after a request timeout', async () => {
    const path = project('request-timeout');
    writeRecord(path, record(path));
    const authenticate = vi.fn(async () => ({
      project_path: realpathSync.native(path), editor_pid: process.pid, editor_start_identity: 'pid-start-1',
    }));
    const send = vi.fn()
      .mockRejectedValueOnce(new EditorRequestTimeoutError('Editor request timed out'))
      .mockResolvedValueOnce({ success: true });
    const disconnect = vi.fn();
    const registry = new EditorSessionRegistry({
      serverVersion: 'test', processExists: () => true,
      connectionFactory: () => ({ authenticate, send, disconnect } as unknown as EditorConnection),
    });

    await expect(registry.send(path, 'driver_state')).rejects.toEqual(expect.any(EditorRequestTimeoutError));
    await expect(registry.send(path, 'resource_transaction')).resolves.toEqual({ success: true });
    expect(authenticate).toHaveBeenCalledOnce();
    expect(disconnect).not.toHaveBeenCalled();
    registry.disconnectAll();
  });

  it('serializes watcher/status discovery with a slow initial authentication', async () => {
    const path = project('slow-authentication');
    writeRecord(path, record(path));
    let releaseAuthentication: (() => void) | undefined;
    const authenticationGate = new Promise<void>(resolve => { releaseAuthentication = resolve; });
    const authenticate = vi.fn(async () => {
      await authenticationGate;
      return {
        project_path: realpathSync.native(path), editor_pid: process.pid,
        editor_start_identity: 'pid-start-1',
      };
    });
    const registry = new EditorSessionRegistry({
      serverVersion: 'test', processExists: () => true,
      connectionFactory: () => ({
        authenticate, send: vi.fn(async () => ({ success: true })), disconnect: vi.fn(),
      } as unknown as EditorConnection),
    });

    const ensured = registry.ensure(path, 2_000);
    await vi.waitFor(() => { expect(authenticate).toHaveBeenCalledOnce(); });
    const status = registry.status(path);
    await new Promise(resolve => setTimeout(resolve, 800));
    expect(authenticate).toHaveBeenCalledOnce();
    releaseAuthentication?.();

    await expect(ensured).resolves.toMatchObject({ connected: true });
    await expect(status).resolves.toMatchObject({ connected: true, reused: true });
    expect(authenticate).toHaveBeenCalledOnce();
    registry.disconnectAll();
  });

  it('preserves a live discovery record after a transient authentication failure', async () => {
    const path = project('transient-authentication');
    writeRecord(path, record(path));
    const authenticate = vi.fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce({
        project_path: realpathSync.native(path), editor_pid: process.pid,
        editor_start_identity: 'pid-start-1',
      });
    const registry = new EditorSessionRegistry({
      serverVersion: 'test', processExists: () => true, retryDelaysMs: [0],
      connectionFactory: () => ({
        authenticate, send: vi.fn(async () => ({ success: true })), disconnect: vi.fn(),
      } as unknown as EditorConnection),
    });

    expect(await registry.status(path)).toMatchObject({
      state: 'no_editor', connected: false,
      reason: expect.stringContaining('temporarily unreachable'),
    });
    expect(existsSync(join(path, EDITOR_SESSION_FILE))).toBe(true);
    await expect(registry.ensure(path, 100)).resolves.toMatchObject({ connected: true });
    expect(authenticate).toHaveBeenCalledTimes(2);
    registry.disconnectAll();
  });
});
