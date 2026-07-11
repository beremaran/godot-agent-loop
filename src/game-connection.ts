import { createConnection, type Socket } from 'net';
import { HANDSHAKE_METHOD, RUNTIME_CAPABILITIES, RUNTIME_PROTOCOL_VERSION, commandMethod, isHandshakeResult, isJsonRpcResponse, type JsonRpcResponse } from './runtime-protocol.js';

export interface GameConnectionOptions {
  port?: number; host?: string; initialDelayMs?: number; retryDelayMs?: number; maxAttempts?: number; log?: (message: string) => void;
}

export type GameResponse = JsonRpcResponse;
type ResponseResolver = (value: GameResponse) => void;

/** Owns the newline-delimited JSON-RPC 2.0 request lifecycle for a running Godot game. */
export class GameConnection {
  private socket: Socket | null = null;
  private connected = false;
  private responseBuffer = '';
  private pendingRequests = new Map<number, ResponseResolver>();
  private projectPath: string | null = null;
  private interactionServerInjectedByUs = false;

  private nextRequestId = 1;
  private readonly port: number;
  private readonly host: string;
  private readonly initialDelayMs: number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly log: (message: string) => void;
  private connectionGeneration = 0;
  private connectingSocket: Socket | null = null;
  private pendingDelay: { timer: ReturnType<typeof setTimeout>; resolve: (active: boolean) => void } | null = null;

  constructor(options: GameConnectionOptions = {}) {
    this.port = options.port ?? 9090;
    this.host = options.host ?? '127.0.0.1';
    this.initialDelayMs = options.initialDelayMs ?? 2000;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.maxAttempts = options.maxAttempts ?? 10;
    this.log = options.log ?? (() => undefined);
  }

  get interactionPort(): number { return this.port; }
  get isConnected(): boolean { return this.connected; }
  get connectedProjectPath(): string | null { return this.projectPath; }

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

  async connect(projectPath: string, isProcessActive: () => boolean): Promise<void> {
    const generation = ++this.connectionGeneration;
    this.cancelPendingDelay(); this.destroySocket(); this.connected = false; this.responseBuffer = '';
    this.rejectAllPending(this.connectionError(null, 'Connection superseded'));
    this.projectPath = projectPath;
    if (!await this.delay(this.initialDelayMs, generation)) return;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (!this.isCurrentGeneration(generation)) return;
      if (!isProcessActive()) { this.log('Game process no longer running, aborting connection'); return; }
      try {
        const connected = await this.connectOnce(attempt, generation);
        if (!connected || !this.isCurrentGeneration(generation)) return;
        return;
      } catch {
        if (!this.isCurrentGeneration(generation)) return;
        this.log(`Connection attempt ${attempt}/${this.maxAttempts} failed, retrying in ${this.retryDelayMs}ms...`);
        if (!await this.delay(this.retryDelayMs, generation)) return;
      }
    }
    if (this.isCurrentGeneration(generation)) console.error(`[SERVER] Failed to connect to game interaction server after ${this.maxAttempts} attempts`);
  }

  disconnect(): void {
    this.connectionGeneration++; this.cancelPendingDelay(); this.destroySocket(); this.connected = false; this.responseBuffer = '';
    this.rejectAllPending(this.connectionError(null, 'Disconnected'));
  }

  rejectAllPending(response: GameResponse): void {
    for (const resolver of this.pendingRequests.values()) resolver(response);
    this.pendingRequests.clear();
  }

  resolveResponse(parsed: unknown): void {
    if (this.pendingRequests.size === 0 || !isJsonRpcResponse(parsed)) return;
    if (typeof parsed.id !== 'number' || !this.pendingRequests.has(parsed.id)) return;
    const resolver = this.pendingRequests.get(parsed.id)!;
    this.pendingRequests.delete(parsed.id);
    resolver(parsed);
  }

  async send(command: string, params: Record<string, unknown> = {}, timeoutMs = 10000): Promise<GameResponse> {
    if (!this.connected || !this.socket) throw new Error('Not connected to game interaction server. Is the game running?');
    return this.request(commandMethod(command), params, timeoutMs);
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<GameResponse> {
    const id = this.nextRequestId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n';
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pendingRequests.delete(id); reject(new Error(`Game request '${method}' timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
      this.pendingRequests.set(id, response => { clearTimeout(timeout); resolve(response); });
      this.socket!.write(payload);
    });
  }

  private connectOnce(attempt: number, generation: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port }, () => {
        if (!this.isCurrentGeneration(generation)) { socket.destroy(); resolve(false); return; }
        this.connectingSocket = null; this.socket = socket; this.connected = true; this.responseBuffer = ''; this.pendingRequests.clear();
        this.log(`Connected to game interaction server (attempt ${attempt})`);
        socket.on('data', data => { if (this.isCurrentSocket(socket, generation)) this.handleData(data); });
        socket.on('close', () => {
          this.log('Game interaction connection closed');
          if (!this.isCurrentSocket(socket, generation)) return;
          this.connected = false; this.socket = null; this.rejectAllPending(this.connectionError(null, 'Connection closed'));
        });
        socket.on('error', err => { this.log(`Game interaction socket error: ${err.message}`); });
        this.negotiateProtocol().then(() => {
          resolve(true);
        }).catch(error => {
          socket.destroy();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      });
      this.connectingSocket = socket;
      socket.on('error', error => { if (this.isCurrentGeneration(generation)) reject(error); else resolve(false); });
      socket.on('close', () => { if (!this.isCurrentGeneration(generation)) resolve(false); });
    });
  }

  private async negotiateProtocol(): Promise<void> {
    const response = await this.request(HANDSHAKE_METHOD, { protocolVersion: RUNTIME_PROTOCOL_VERSION, capabilities: [...RUNTIME_CAPABILITIES] }, 5000);
    if ('error' in response) throw new Error(response.error.message);
    if (!isHandshakeResult(response.result)) throw new Error('invalid handshake result');
    const handshake = response.result;
    if (handshake.protocolVersion !== RUNTIME_PROTOCOL_VERSION) throw new Error(`unsupported runtime protocol version ${handshake.protocolVersion}`);
    const missing = RUNTIME_CAPABILITIES.filter(capability => !handshake.capabilities.includes(capability));
    if (missing.length > 0) throw new Error(`runtime does not support ${missing.join(', ')}`);
  }

  private isCurrentGeneration(generation: number): boolean { return generation === this.connectionGeneration; }
  private isCurrentSocket(socket: Socket, generation: number): boolean { return this.isCurrentGeneration(generation) && this.socket === socket; }
  private delay(milliseconds: number, generation: number): Promise<boolean> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pendingDelay = null; resolve(this.isCurrentGeneration(generation)); }, milliseconds);
      this.pendingDelay = { timer, resolve };
    });
  }
  private cancelPendingDelay(): void {
    if (this.pendingDelay !== null) { clearTimeout(this.pendingDelay.timer); this.pendingDelay.resolve(false); this.pendingDelay = null; }
  }
  private destroySocket(): void {
    const sockets = [this.socket, this.connectingSocket]; this.socket = null; this.connectingSocket = null;
    for (const socket of sockets) socket?.destroy();
  }
  private handleData(data: Buffer): void {
    this.responseBuffer += data.toString();
    while (this.responseBuffer.includes('\n')) {
      const newlinePos = this.responseBuffer.indexOf('\n');
      const line = this.responseBuffer.substring(0, newlinePos).trim(); this.responseBuffer = this.responseBuffer.substring(newlinePos + 1);
      if (!line) continue;
      try { this.resolveResponse(JSON.parse(line)); } catch { this.log(`Failed to parse game response: ${line}`); }
    }
  }
  private connectionError(id: number | null, message: string): GameResponse { return { jsonrpc: '2.0', id, error: { code: -32000, message } }; }
}
