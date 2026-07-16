import { createConnection, type Socket } from 'net';
import { performance } from 'perf_hooks';
import { AUTHORING_COMMANDS_CAPABILITY, CANCEL_METHOD, HANDSHAKE_METHOD, PRIVILEGED_RUNTIME_CAPABILITY, PRIVILEGED_RUNTIME_COMMANDS, PRIVILEGED_RUNTIME_COMMAND_GROUPS, RUNTIME_CAPABILITIES, RUNTIME_PROTOCOL_VERSION, SESSION_AUTHENTICATION_CAPABILITY, commandMethod, isAuthoringCommand, isHandshakeResult, isJsonRpcResponse, isSessionCommand, privilegedGroupCapability, type JsonRpcResponse, type PrivilegedRuntimeGroup } from './runtime-protocol.js';
import { abortError, throwIfCancelled } from './execution-context.js';

export interface GameConnectionOptions {
  port?: number; host?: string; initialDelayMs?: number; retryDelayMs?: number; maxAttempts?: number; log?: (message: string) => void; allowPrivilegedCommands?: boolean; allowedPrivilegedGroups?: readonly PrivilegedRuntimeGroup[]; authSecret?: string; onLifecycleEvent?: (event: GameLifecycleEvent) => void;
}

export interface GameLifecycleEvent {
  event: 'request_started' | 'request_finished' | 'request_timed_out' | 'request_cancelled';
  correlation_id: string;
  command: string;
  target: string;
  outcome?: 'success' | 'error' | 'timeout' | 'cancelled';
  duration_ms?: number;
  error_code?: number;
}

export type GameResponse = JsonRpcResponse;
interface PendingRequest {
  resolve: (value: GameResponse) => void;
  reject: (reason: Error) => void;
  cleanup: () => void;
}

/** Owns the newline-delimited JSON-RPC 2.0 request lifecycle for a running Godot game. */
export class GameConnection {
  private socket: Socket | null = null;
  private connected = false;
  private responseBuffer = '';
  private pendingRequests = new Map<number, PendingRequest>();
  private projectPath: string | null = null;
  private interactionServerInjectedByUs = false;

  private nextRequestId = 1;
  private readonly port: number;
  private readonly host: string;
  private readonly initialDelayMs: number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly log: (message: string) => void;
  private readonly allowPrivilegedCommands: boolean;
  private readonly allowedPrivilegedGroups: ReadonlySet<PrivilegedRuntimeGroup>;
  private readonly authSecret: string | undefined;
  private readonly onLifecycleEvent: (event: GameLifecycleEvent) => void;
  private runtimeCapabilities: string[] = [];
  private runtimeHandshake: import('./runtime-protocol.js').RuntimeHandshake | null = null;
  private connectionGeneration = 0;
  private connectingSocket: Socket | null = null;
  private pendingDelay: { timer: ReturnType<typeof setTimeout>; resolve: (active: boolean) => void } | null = null;

  constructor(options: GameConnectionOptions = {}) {
    this.port = options.port ?? 9090;
    this.host = options.host ?? '127.0.0.1';
    this.initialDelayMs = options.initialDelayMs ?? 2000;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    // Cold editor imports and shader compilation can exceed the old seven-second
    // connection window on fresh CI machines. Keep retrying for roughly 90s,
    // while connect() still aborts immediately when the process exits.
    this.maxAttempts = options.maxAttempts ?? 180;
    this.log = options.log ?? (() => undefined);
    this.allowPrivilegedCommands = options.allowPrivilegedCommands ?? false;
    this.allowedPrivilegedGroups = new Set(options.allowedPrivilegedGroups ?? []);
    this.authSecret = options.authSecret;
    this.onLifecycleEvent = options.onLifecycleEvent ?? (() => undefined);
  }

  get interactionPort(): number { return this.port; }
  get isConnected(): boolean { return this.connected; }
  get connectedProjectPath(): string | null { return this.projectPath; }
  get handshake(): Readonly<import('./runtime-protocol.js').RuntimeHandshake> | null { return this.runtimeHandshake; }
  public supportsCapability(capability: string): boolean { return this.runtimeCapabilities.includes(capability); }

  /** Records whether this server added the interaction autoload for the active project. */
  public recordInteractionServerInstallation(installed: boolean): void {
    this.interactionServerInjectedByUs = installed;
  }

  /** Returns and clears ownership so removal is performed at most once. */
  public consumeInteractionServerOwnership(): boolean {
    const ownedByMcp = this.interactionServerInjectedByUs;
    this.interactionServerInjectedByUs = false;
    return ownedByMcp;
  }

  /** Clears the project association after its interaction server has been removed. */
  public clearConnectedProject(): void {
    this.projectPath = null;
  }

  async connect(projectPath: string, isProcessActive: () => boolean, signal?: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    const generation = ++this.connectionGeneration;
    this.cancelPendingDelay(); this.destroySocket(); this.connected = false; this.responseBuffer = '';
    this.rejectAllPending(this.connectionError(null, 'Connection superseded'));
    this.projectPath = projectPath;
    if (!await this.delay(this.initialDelayMs, generation, signal)) {
      throwIfCancelled(signal);
      return;
    }
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      throwIfCancelled(signal);
      if (!this.isCurrentGeneration(generation)) throw new Error('Runtime connection was superseded');
      if (!isProcessActive()) {
        this.logEvent('connection_aborted', { reason: 'process_not_running' });
        throw new Error('Godot exited before the runtime became ready');
      }
      try {
        const connected = await this.connectOnce(attempt, generation, signal);
        if (!connected || !this.isCurrentGeneration(generation)) throw new Error('Runtime connection was superseded');
        return;
      } catch (error) {
        throwIfCancelled(signal);
        if (!this.isCurrentGeneration(generation)) throw error;
        this.logEvent('connection_retry', {
          attempt, max_attempts: this.maxAttempts, retry_delay_ms: this.retryDelayMs,
        });
        if (!await this.delay(this.retryDelayMs, generation, signal)) {
          throwIfCancelled(signal);
          return;
        }
      }
    }
    if (this.isCurrentGeneration(generation)) {
      console.error(JSON.stringify({
        component: 'godot-agent-loop-server', event: 'connection_failed', attempts: this.maxAttempts,
      }));
      throw new Error(`Runtime did not become ready after ${this.maxAttempts} connection attempts`);
    }
  }

  disconnect(): void {
    this.connectionGeneration++; this.cancelPendingDelay(); this.destroySocket(); this.connected = false; this.responseBuffer = ''; this.runtimeCapabilities = []; this.runtimeHandshake = null;
    this.rejectAllPending(this.connectionError(null, 'Disconnected'));
  }

  rejectAllPending(response: GameResponse): void {
    for (const pending of this.pendingRequests.values()) {
      pending.cleanup();
      pending.resolve(response);
    }
    this.pendingRequests.clear();
  }

  resolveResponse(parsed: unknown): void {
    if (this.pendingRequests.size === 0 || !isJsonRpcResponse(parsed)) return;
    if (typeof parsed.id !== 'number' || !this.pendingRequests.has(parsed.id)) return;
    const pending = this.pendingRequests.get(parsed.id)!;
    this.pendingRequests.delete(parsed.id);
    pending.cleanup();
    pending.resolve(parsed);
  }

  async send(command: string, params: Record<string, unknown> = {}, timeoutMs = 10000, signal?: AbortSignal): Promise<GameResponse> {
    throwIfCancelled(signal);
    if (!isSessionCommand(command)) throw new Error(`'${command}' is not a command in the published session contract`);
    if (isAuthoringCommand(command) && !this.runtimeCapabilities.includes(AUTHORING_COMMANDS_CAPABILITY)) {
      throw new Error(`runtime does not expose the harness-owned ${AUTHORING_COMMANDS_CAPABILITY} capability`);
    }
    const isPrivileged = PRIVILEGED_RUNTIME_COMMANDS.includes(command as typeof PRIVILEGED_RUNTIME_COMMANDS[number]);
    if (isPrivileged) {
      const privilegedCommand = command as typeof PRIVILEGED_RUNTIME_COMMANDS[number];
      const group = PRIVILEGED_RUNTIME_COMMAND_GROUPS[privilegedCommand];
      if (!this.allowPrivilegedCommands && !this.allowedPrivilegedGroups.has(group)) {
        throw new Error(`Privileged runtime command '${command}' is disabled. Enable group '${group}' with GODOT_MCP_PRIVILEGED_GROUPS or opt in to all privileged commands.`);
      }
      const capability = privilegedGroupCapability(group);
      if (!this.runtimeCapabilities.includes(PRIVILEGED_RUNTIME_CAPABILITY)
        && !this.runtimeCapabilities.includes(capability)) {
        throw new Error(`runtime did not authorize privileged group '${group}'`);
      }
    }
    if (!this.connected || !this.socket) throw new Error('Not connected to game interaction server. Is the game running?');
    return this.request(commandMethod(command), params, timeoutMs, signal);
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<GameResponse> {
    throwIfCancelled(signal);
    const id = this.nextRequestId++;
    const isCommand = method.startsWith('godot.runtime.')
      && method !== HANDSHAKE_METHOD && method !== CANCEL_METHOD;
    const correlationId = isCommand ? `mcp_${id}` : undefined;
    const wireParams = correlationId === undefined ? params : { ...params, _mcp_correlation_id: correlationId };
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params: wireParams, id }) + '\n';
    const startedAt = performance.now();
    const command = method.slice('godot.runtime.'.length);
    const target = requestTarget(params);
    if (correlationId !== undefined) {
      this.logEvent('request_started', { correlation_id: correlationId, method });
      this.emitLifecycle({ event: 'request_started', correlation_id: correlationId, command, target });
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        this.pendingRequests.delete(id);
        pending.cleanup();
        this.requestCancellation(id);
        if (correlationId !== undefined) {
          const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
          this.logEvent('request_timed_out', { correlation_id: correlationId, method, timeout_ms: timeoutMs, duration_ms: durationMs });
          this.emitLifecycle({
            event: 'request_timed_out', correlation_id: correlationId, command, target,
            outcome: 'timeout', duration_ms: durationMs,
          });
        }
        reject(new Error(`Game request '${method}' timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      const onAbort = () => {
        if (!this.pendingRequests.delete(id)) return;
        clearTimeout(timeout);
        this.requestCancellation(id);
        if (correlationId !== undefined) {
          const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
          this.logEvent('request_cancelled', { correlation_id: correlationId, method, duration_ms: durationMs });
          this.emitLifecycle({
            event: 'request_cancelled', correlation_id: correlationId, command, target,
            outcome: 'cancelled', duration_ms: durationMs,
          });
        }
        reject(abortError(signal?.reason));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
      };
      this.pendingRequests.set(id, { resolve: response => {
        cleanup();
        if (correlationId !== undefined) {
          const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
          const outcome = 'error' in response ? 'error' : 'success';
          this.logEvent('request_finished', {
            correlation_id: correlationId, method,
            outcome, duration_ms: durationMs,
            ...('error' in response ? { error_code: response.error.code } : {}),
          });
          this.emitLifecycle({
            event: 'request_finished', correlation_id: correlationId, command, target,
            outcome, duration_ms: durationMs,
            ...('error' in response ? { error_code: response.error.code } : {}),
          });
        }
        resolve(response);
      }, reject, cleanup });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.socket!.write(payload);
    });
  }

  private connectOnce(attempt: number, generation: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        socket.destroy();
        reject(abortError(signal?.reason));
      };
      const socket = createConnection({ host: this.host, port: this.port }, () => {
        signal?.removeEventListener('abort', onAbort);
        if (!this.isCurrentGeneration(generation)) { socket.destroy(); resolve(false); return; }
        this.connectingSocket = null; this.socket = socket; this.connected = true; this.responseBuffer = ''; this.runtimeCapabilities = []; this.pendingRequests.clear();
        this.logEvent('connection_opened', { attempt });
        socket.on('data', data => { if (this.isCurrentSocket(socket, generation)) this.handleData(data); });
        socket.on('close', () => {
          this.logEvent('connection_closed');
          if (!this.isCurrentSocket(socket, generation)) return;
          this.connected = false; this.socket = null; this.rejectAllPending(this.connectionError(null, 'Connection closed'));
        });
        socket.on('error', () => { this.logEvent('connection_error'); });
        this.negotiateProtocol().then(() => {
          resolve(true);
        }).catch(error => {
          socket.destroy();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      });
      this.connectingSocket = socket;
      signal?.addEventListener('abort', onAbort, { once: true });
      socket.on('error', error => { if (this.isCurrentGeneration(generation)) reject(error); else resolve(false); });
      socket.on('close', () => { if (!this.isCurrentGeneration(generation)) resolve(false); });
    });
  }

  private async negotiateProtocol(): Promise<void> {
    const requestedCapabilities: string[] = [...RUNTIME_CAPABILITIES];
    if (this.authSecret !== undefined) requestedCapabilities.push(SESSION_AUTHENTICATION_CAPABILITY);
    if (this.allowPrivilegedCommands) requestedCapabilities.push(PRIVILEGED_RUNTIME_CAPABILITY);
    for (const group of this.allowedPrivilegedGroups) requestedCapabilities.push(privilegedGroupCapability(group));
    const response = await this.request(HANDSHAKE_METHOD, {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      capabilities: requestedCapabilities,
      ...(this.authSecret === undefined ? {} : { secret: this.authSecret }),
    }, 5000);
    if ('error' in response) throw new Error(response.error.message);
    if (!isHandshakeResult(response.result)) throw new Error('invalid handshake result');
    const handshake = response.result;
    if (handshake.protocolVersion !== RUNTIME_PROTOCOL_VERSION) throw new Error(`unsupported runtime protocol version ${handshake.protocolVersion}`);
    const missing = RUNTIME_CAPABILITIES.filter(capability => !handshake.capabilities.includes(capability));
    if (missing.length > 0) throw new Error(`runtime does not support ${missing.join(', ')}`);
    if (this.authSecret !== undefined && !handshake.capabilities.includes(SESSION_AUTHENTICATION_CAPABILITY)) {
      throw new Error('runtime did not confirm session authentication');
    }
    if (this.allowPrivilegedCommands && !handshake.capabilities.includes(PRIVILEGED_RUNTIME_CAPABILITY)) {
      throw new Error(`runtime does not support privileged runtime commands; enable ${PRIVILEGED_RUNTIME_CAPABILITY} in the Godot interaction server`);
    }
    for (const group of this.allowedPrivilegedGroups) {
      if (!handshake.capabilities.includes(PRIVILEGED_RUNTIME_CAPABILITY)
        && !handshake.capabilities.includes(privilegedGroupCapability(group))) {
        throw new Error(`runtime does not support privileged group '${group}'`);
      }
    }
    this.runtimeCapabilities = handshake.capabilities;
    this.runtimeHandshake = handshake;
  }

  private isCurrentGeneration(generation: number): boolean { return generation === this.connectionGeneration; }
  private isCurrentSocket(socket: Socket, generation: number): boolean { return this.isCurrentGeneration(generation) && this.socket === socket; }
  private delay(milliseconds: number, generation: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
      const onAbort = () => {
        clearTimeout(timer);
        if (this.pendingDelay?.timer === timer) this.pendingDelay = null;
        resolve(false);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        this.pendingDelay = null;
        resolve(this.isCurrentGeneration(generation));
      }, milliseconds);
      this.pendingDelay = { timer, resolve };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  private cancelPendingDelay(): void {
    if (this.pendingDelay !== null) { clearTimeout(this.pendingDelay.timer); this.pendingDelay.resolve(false); this.pendingDelay = null; }
  }
  private destroySocket(): void {
    const sockets = [this.socket, this.connectingSocket]; this.socket = null; this.connectingSocket = null;
    for (const socket of sockets) socket?.destroy();
  }
  /** Best-effort cooperative cancellation; servers acknowledge it separately. */
  private requestCancellation(requestId: number): void {
    if (!this.connected || !this.socket) return;
    const id = this.nextRequestId++;
    this.socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: CANCEL_METHOD, params: { request_id: requestId }, id })}\n`);
  }
  private handleData(data: Buffer): void {
    this.responseBuffer += data.toString();
    while (this.responseBuffer.includes('\n')) {
      const newlinePos = this.responseBuffer.indexOf('\n');
      const line = this.responseBuffer.substring(0, newlinePos).trim(); this.responseBuffer = this.responseBuffer.substring(newlinePos + 1);
      if (!line) continue;
      try { this.resolveResponse(JSON.parse(line)); } catch {
        this.logEvent('response_parse_failed', { response_bytes: Buffer.byteLength(line) });
      }
    }
  }
  private logEvent(event: string, details: Record<string, unknown> = {}): void {
    this.log(JSON.stringify({ component: 'godot-agent-loop-server', event, ...details }));
  }
  private emitLifecycle(event: GameLifecycleEvent): void {
    try { this.onLifecycleEvent(event); } catch { /* Observation must never break command delivery. */ }
  }
  private connectionError(id: number | null, message: string): GameResponse { return { jsonrpc: '2.0', id, error: { code: -32000, message } }; }
}

function requestTarget(params: Record<string, unknown>): string {
  for (const key of ['node_path', 'scene_path', 'resource_path', 'parent_path', 'group', 'action']) {
    const value = params[key];
    if (typeof value === 'string' && value.length > 0) return value.slice(0, 256);
  }
  return 'game';
}
