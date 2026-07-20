import { existsSync, realpathSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  EditorBridgeCompatibilityError,
  EditorConnection,
  EditorRequestTimeoutError,
} from './editor-connection.js';
import { EDITOR_BRIDGE_PROTOCOL_VERSION } from './editor-bridge-protocol.js';
import { cancellableDelay, throwIfCancelled } from './execution-context.js';

export const EDITOR_SESSION_DIRECTORY = join('.godot', 'godot_agent_loop');
export const EDITOR_SESSION_FILE = join(EDITOR_SESSION_DIRECTORY, 'editor-session.json');

export type EditorSessionState =
  | 'connected'
  | 'no_editor'
  | 'addon_missing_restart_required'
  | 'addon_upgrade_restart_required'
  | 'protocol_incompatible'
  | 'paused'
  | 'syncing'
  | 'unsaved_conflict';

export interface EditorSessionDiscoveryRecord {
  project_path: string;
  editor_pid: number;
  editor_start_identity: string;
  port: number;
  token: string;
  protocol_version: string;
  addon_version: string;
  godot_version: string;
  created_at: string;
}

export interface PublicEditorSession {
  state: EditorSessionState;
  project_path: string;
  connected: boolean;
  reused: boolean;
  spawned: boolean;
  editor_pid: number | null;
  editor_start_identity: string | null;
  port: number | null;
  protocol_version: string | null;
  addon_version: string | null;
  godot_version: string | null;
  created_at: string | null;
  plugin_owned?: boolean;
  plugin_distribution?: 'persistent' | 'transient' | 'unavailable';
  process_alive?: boolean | null;
  reason?: string;
}

interface RegistryEntry {
  record: EditorSessionDiscoveryRecord;
  connection: EditorConnection;
  state: EditorSessionState;
}

export interface EditorSessionRegistryOptions {
  serverVersion: string;
  connectionFactory?: (record: EditorSessionDiscoveryRecord) => EditorConnection;
  processExists?: (pid: number) => boolean;
  retryDelaysMs?: readonly number[];
  onStateChange?: (session: PublicEditorSession) => void;
  log?: (message: string) => void;
}

/** Secure, reconnectable editor bridges keyed by canonical Godot project path. */
export class EditorSessionRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly trackedProjects = new Set<string>();
  private readonly operationTails = new Map<string, Promise<void>>();
  private readonly emittedSignatures = new Map<string, string>();
  private readonly retryDelaysMs: readonly number[];
  private watcher: NodeJS.Timeout | null = null;

  constructor(private readonly options: EditorSessionRegistryOptions) {
    this.retryDelaysMs = options.retryDelaysMs ?? [0, 50, 100, 250, 500, 1_000, 2_000];
  }

  async ensure(projectPath: string, timeoutMs = 10_000, signal?: AbortSignal): Promise<PublicEditorSession> {
    const canonical = canonicalProjectPath(projectPath);
    throwIfCancelled(signal);
    return this.serialize(canonical, () => this.ensureDiscovered(canonical, timeoutMs, signal));
  }

  async status(projectPath: string): Promise<PublicEditorSession> {
    const canonical = canonicalProjectPath(projectPath);
    return this.serialize(canonical, async () => {
      this.track(canonical);
      return this.discover(canonical);
    });
  }

  private async ensureDiscovered(canonical: string, timeoutMs: number, signal?: AbortSignal): Promise<PublicEditorSession> {
    throwIfCancelled(signal);
    this.track(canonical);
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let last = await this.discover(canonical);
    let attempt = 0;
    while (!last.connected && last.state === 'no_editor' && Date.now() < deadline) {
      const delay = this.retryDelaysMs[Math.min(attempt++, this.retryDelaysMs.length - 1)] ?? 250;
      if (delay > 0) await cancellableDelay(Math.min(delay, Math.max(1, deadline - Date.now())), signal);
      last = await this.discover(canonical);
    }
    return last;
  }

  async send(
    projectPath: string,
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10_000,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const canonical = canonicalProjectPath(projectPath);
    throwIfCancelled(signal);
    return this.serialize(canonical, async () => {
      throwIfCancelled(signal);
      const session = await this.ensureDiscovered(canonical, Math.min(timeoutMs, 2_000), signal);
      if (!session.connected) throw new EditorSessionUnavailableError(session);
      const entry = this.entries.get(canonical);
      if (!entry) throw new EditorSessionUnavailableError(session);
      try {
        const result = await entry.connection.send(command, params, timeoutMs, signal);
        entry.state = editorStateFromResult(result, entry.state);
        this.emit(this.publicSession(canonical, entry, true));
        return result;
      } catch (error) {
        // A request can time out while Godot's main thread is briefly busy
        // importing or saving a resource. The socket remains usable, so keep
        // the authenticated session instead of forcing a competing reconnect.
        if (!(error instanceof EditorRequestTimeoutError)) {
          entry.connection.disconnect();
          this.entries.delete(canonical);
        }
        throw error;
      }
    });
  }

  disconnect(projectPath: string): PublicEditorSession {
    const canonical = canonicalProjectPath(projectPath);
    const entry = this.entries.get(canonical);
    const processAlive = entry
      ? (this.options.processExists ?? processExists)(entry.record.editor_pid)
      : null;
    entry?.connection.disconnect();
    this.entries.delete(canonical);
    this.trackedProjects.delete(canonical);
    this.emittedSignatures.delete(canonical);
    const session = emptySession(canonical, 'no_editor', processAlive
      ? 'MCP connection detached; Godot editor process remains open'
      : 'Disconnected by caller');
    session.process_alive = processAlive;
    this.emit(session);
    this.stopWatcherIfIdle();
    return session;
  }

  disconnectAll(): void {
    for (const entry of this.entries.values()) entry.connection.disconnect();
    this.entries.clear();
    this.trackedProjects.clear();
    this.emittedSignatures.clear();
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
  }

  private async discover(canonical: string): Promise<PublicEditorSession> {
    const recordResult = readDiscoveryRecord(canonical, this.options.processExists ?? processExists);
    if ('state' in recordResult) {
      const old = this.entries.get(canonical);
      old?.connection.disconnect();
      this.entries.delete(canonical);
      this.emit(recordResult);
      return recordResult;
    }
    const record = recordResult.record;
    const existing = this.entries.get(canonical);
    const sameRecord = existing
      && existing.record.editor_start_identity === record.editor_start_identity
      && existing.record.port === record.port;
    if (sameRecord) return this.publicSession(canonical, existing, true);
    existing?.connection.disconnect();
    const connection = this.options.connectionFactory?.(record) ?? new EditorConnection({
      port: record.port,
      secret: record.token,
      protocolVersion: EDITOR_BRIDGE_PROTOCOL_VERSION,
      serverVersion: this.options.serverVersion,
    });
    try {
      const handshake = await connection.authenticate(2_000);
      validateHandshake(record, handshake);
      const state = handshake.paused === true ? 'paused' : 'connected';
      const entry: RegistryEntry = { record, connection, state };
      this.entries.set(canonical, entry);
      const session = this.publicSession(canonical, entry, true);
      this.emit(session);
      return session;
    } catch (error) {
      connection.disconnect();
      if (error instanceof EditorBridgeCompatibilityError) {
        const session = publicRecord(record, 'protocol_incompatible', false, error.message);
        this.emit(session);
        return session;
      }
      const pidExists = this.options.processExists ?? processExists;
      const invalidIdentity = error instanceof EditorSessionIdentityError;
      const processAlive = pidExists(record.editor_pid);
      if (invalidIdentity || !processAlive) cleanStaleRecord(canonical);
      const session = invalidIdentity || !processAlive
        ? emptySession(canonical, 'no_editor', `Stale editor session removed: ${errorMessage(error)}`)
        : publicRecord(record, 'no_editor', false, `Live editor session is temporarily unreachable: ${errorMessage(error)}`);
      this.emit(session);
      return session;
    }
  }

  private publicSession(canonical: string, entry: RegistryEntry, reused: boolean): PublicEditorSession {
    return { ...publicRecord(entry.record, entry.state, true), project_path: canonical, reused };
  }

  private track(canonical: string): void {
    this.trackedProjects.add(canonical);
    if (this.watcher) return;
    this.watcher = setInterval(() => {
      for (const projectPath of this.trackedProjects) {
        // An editor can accept only one agent connection. Do not let the
        // watcher start a second authentication while an ensure/send is still
        // establishing or using the project's connection.
        if (this.operationTails.has(projectPath)) continue;
        void this.status(projectPath).catch(error => {
          this.options.log?.(`Editor discovery failed for ${projectPath}: ${errorMessage(error)}`);
        });
      }
    }, 750);
    this.watcher.unref();
  }

  private stopWatcherIfIdle(): void {
    if (this.trackedProjects.size > 0 || !this.watcher) return;
    clearInterval(this.watcher);
    this.watcher = null;
  }

  private emit(session: PublicEditorSession): void {
    const signature = `${session.state}:${session.editor_start_identity ?? ''}:${session.connected}`;
    if (this.emittedSignatures.get(session.project_path) === signature) return;
    this.emittedSignatures.set(session.project_path, signature);
    this.options.onStateChange?.(session);
  }

  private serialize<T>(projectPath: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTails.get(projectPath) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.operationTails.set(projectPath, tail);
    void tail.finally(() => {
      if (this.operationTails.get(projectPath) === tail) this.operationTails.delete(projectPath);
    });
    return result;
  }
}

export class EditorSessionUnavailableError extends Error {
  constructor(readonly session: PublicEditorSession) {
    super(`Editor session is unavailable (${session.state})${session.reason ? `: ${session.reason}` : ''}`);
    this.name = 'EditorSessionUnavailableError';
  }
}

export function readDiscoveryRecord(
  projectPath: string,
  pidExists: (pid: number) => boolean = processExists,
): { record: EditorSessionDiscoveryRecord } | PublicEditorSession {
  const canonical = canonicalProjectPath(projectPath);
  const sessionPath = join(canonical, EDITOR_SESSION_FILE);
  let raw: unknown;
  try {
    if (process.platform !== 'win32' && (statSync(sessionPath).mode & 0o077) !== 0) {
      cleanStaleRecord(canonical);
      return emptySession(canonical, 'no_editor', 'Discovery record permissions were not private');
    }
    raw = JSON.parse(readFileSync(sessionPath, 'utf8'));
  } catch (error) {
    if (isMissingFile(error)) return sessionWithoutDiscoveryRecord(canonical);
    cleanStaleRecord(canonical);
    return emptySession(canonical, 'no_editor', `Invalid discovery record: ${errorMessage(error)}`);
  }
  if (!isDiscoveryRecord(raw)) {
    cleanStaleRecord(canonical);
    return emptySession(canonical, 'no_editor', 'Invalid discovery record schema');
  }
  let recordProject: string;
  try { recordProject = canonicalProjectPath(raw.project_path); } catch {
    cleanStaleRecord(canonical);
    return emptySession(canonical, 'no_editor', 'Discovery record project path is invalid');
  }
  if (recordProject !== canonical || !isLoopbackPort(raw.port) || !pidExists(raw.editor_pid)) {
    cleanStaleRecord(canonical);
    const discovered = sessionWithoutDiscoveryRecord(canonical);
    return {
      ...discovered,
      reason: `Stale or cross-project discovery record removed${discovered.reason ? `. ${discovered.reason}` : ''}`,
    };
  }
  if (raw.protocol_version !== EDITOR_BRIDGE_PROTOCOL_VERSION) {
    return publicRecord(raw, 'protocol_incompatible', false,
      `Server protocol ${EDITOR_BRIDGE_PROTOCOL_VERSION}, addon protocol ${raw.protocol_version}`);
  }
  return { record: { ...raw, project_path: canonical } };
}

function sessionWithoutDiscoveryRecord(projectPath: string): PublicEditorSession {
  const candidates = [
    { name: 'godot_agent_loop', path: join(projectPath, 'addons', 'godot_agent_loop', 'plugin.cfg') },
    { name: 'godot_agent_loop_transient', path: join(projectPath, 'addons', 'godot_agent_loop_transient', 'plugin.cfg') },
  ];
  const installed = candidates.find(candidate => existsSync(candidate.path));
  if (!installed) {
    return emptySession(projectPath, 'addon_missing_restart_required',
      'Install and enable addons/godot_agent_loop, then restart Godot once');
  }
  let config: string;
  try {
    config = readFileSync(installed.path, 'utf8');
  } catch (error) {
    return emptySession(projectPath, 'addon_missing_restart_required',
      `Installed addon could not be read: ${errorMessage(error)}`);
  }
  const protocol = /^protocol_version\s*=\s*"([^"]+)"/m.exec(config)?.[1];
  if (protocol !== EDITOR_BRIDGE_PROTOCOL_VERSION) {
    return emptySession(projectPath, 'addon_upgrade_restart_required',
      `Installed addon protocol ${protocol ?? 'missing'} must be replaced with protocol ${EDITOR_BRIDGE_PROTOCOL_VERSION}, then Godot restarted`);
  }
  let projectSource = '';
  try { projectSource = readFileSync(join(projectPath, 'project.godot'), 'utf8'); } catch { /* validation occurs at the tool boundary */ }
  const enabledSection = /(?:^|\n)\[editor_plugins\]\s*\n([\s\S]*?)(?=\n\[|$)/.exec(projectSource)?.[1] ?? '';
  const enabledLine = /^enabled\s*=\s*PackedStringArray\((.*)\)\s*$/m.exec(enabledSection)?.[1] ?? '';
  const enabled = [...enabledLine.matchAll(/"(?:\\.|[^"])*"/g)]
    .some(match => {
      try {
        const value = JSON.parse(match[0]);
        return value === installed.name || value === `res://addons/${installed.name}/plugin.cfg`;
      } catch { return false; }
    });
  if (!enabled) {
    return emptySession(projectPath, 'addon_missing_restart_required',
      `The ${installed.name} addon is installed but disabled; enable it and restart Godot`);
  }
  return emptySession(projectPath, 'no_editor',
    'A compatible addon is enabled, but no matching editor session is currently discoverable');
}

function validateHandshake(record: EditorSessionDiscoveryRecord, result: Record<string, unknown>): void {
  if (result.error) {
    throw new Error(typeof result.error === 'string' ? result.error : JSON.stringify(result.error));
  }
  if (result.project_path !== record.project_path
    || result.editor_pid !== record.editor_pid
    || result.editor_start_identity !== record.editor_start_identity) {
    throw new EditorSessionIdentityError('Editor handshake identity did not match its discovery record');
  }
}

class EditorSessionIdentityError extends Error {}

function isDiscoveryRecord(value: unknown): value is EditorSessionDiscoveryRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.project_path === 'string'
    && Number.isInteger(record.editor_pid) && Number(record.editor_pid) > 0
    && typeof record.editor_start_identity === 'string' && record.editor_start_identity.length > 0
    && Number.isInteger(record.port)
    && typeof record.token === 'string' && record.token.length >= 32
    && typeof record.protocol_version === 'string'
    && typeof record.addon_version === 'string'
    && typeof record.godot_version === 'string'
    && typeof record.created_at === 'string';
}

function publicRecord(
  record: EditorSessionDiscoveryRecord,
  state: EditorSessionState,
  connected: boolean,
  reason?: string,
): PublicEditorSession {
  const persistent = existsSync(join(record.project_path, 'addons', 'godot_agent_loop', 'plugin.cfg'));
  const transient = existsSync(join(record.project_path, 'addons', 'godot_agent_loop_transient', 'plugin.cfg'));
  return {
    state,
    project_path: record.project_path,
    connected,
    reused: connected,
    spawned: false,
    editor_pid: record.editor_pid,
    editor_start_identity: record.editor_start_identity,
    port: record.port,
    protocol_version: record.protocol_version,
    addon_version: record.addon_version,
    godot_version: record.godot_version,
    created_at: record.created_at,
    plugin_owned: false,
    plugin_distribution: persistent ? 'persistent' : transient ? 'transient' : 'unavailable',
    ...(reason ? { reason } : {}),
  };
}

function emptySession(projectPath: string, state: EditorSessionState, reason?: string): PublicEditorSession {
  return {
    state,
    project_path: projectPath,
    connected: false,
    reused: false,
    spawned: false,
    editor_pid: null,
    editor_start_identity: null,
    port: null,
    protocol_version: null,
    addon_version: null,
    godot_version: null,
    created_at: null,
    ...(reason ? { reason } : {}),
  };
}

function editorStateFromResult(result: Record<string, unknown>, fallback: EditorSessionState): EditorSessionState {
  const state = result.state;
  if (typeof state === 'string' && EDITOR_STATES.has(state as EditorSessionState)) return state as EditorSessionState;
  if (result.error === 'unsaved_conflict') return 'unsaved_conflict';
  if (result.paused === true) return 'paused';
  return fallback === 'paused' ? 'connected' : fallback;
}

const EDITOR_STATES = new Set<EditorSessionState>([
  'connected', 'no_editor', 'addon_missing_restart_required', 'addon_upgrade_restart_required',
  'protocol_incompatible', 'paused', 'syncing', 'unsaved_conflict',
]);

export function canonicalProjectPath(projectPath: string): string {
  const absolute = resolve(projectPath);
  try { return realpathSync.native(absolute); } catch { return absolute; }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM');
  }
}

function isLoopbackPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65_536;
}

function cleanStaleRecord(projectPath: string): void {
  try { rmSync(join(projectPath, EDITOR_SESSION_FILE), { force: true }); } catch { /* best effort stale cleanup */ }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
