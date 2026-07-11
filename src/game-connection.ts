import { createConnection, type Socket } from 'net';

export interface GameConnectionOptions {
  port?: number;
  host?: string;
  initialDelayMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  log?: (message: string) => void;
}

export interface GameResponse {
  id?: number;
  error?: string;
  [key: string]: unknown;
}

type ResponseResolver = (value: GameResponse) => void;

/** Owns the TCP protocol and request lifecycle for a running Godot game. */
export class GameConnection {
  public socket: Socket | null = null;
  public connected = false;
  public responseBuffer = '';
  public pendingRequests = new Map<number, ResponseResolver>();
  public projectPath: string | null = null;
  public interactionServerInjectedByUs = false;

  private nextRequestId = 1;
  private readonly port: number;
  private readonly host: string;
  private readonly initialDelayMs: number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly log: (message: string) => void;
  private connectionGeneration = 0;
  private connectingSocket: Socket | null = null;
  private pendingDelay: {
    timer: ReturnType<typeof setTimeout>;
    resolve: (active: boolean) => void;
  } | null = null;

  constructor(options: GameConnectionOptions = {}) {
    this.port = options.port ?? 9090;
    this.host = options.host ?? '127.0.0.1';
    this.initialDelayMs = options.initialDelayMs ?? 2000;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.maxAttempts = options.maxAttempts ?? 10;
    this.log = options.log ?? (() => undefined);
  }

  get interactionPort(): number {
    return this.port;
  }

  async connect(projectPath: string, isProcessActive: () => boolean): Promise<void> {
    const generation = ++this.connectionGeneration;
    this.cancelPendingDelay();
    this.destroySocket();
    this.connected = false;
    this.responseBuffer = '';
    this.rejectAllPending({ error: 'Connection superseded' });
    this.projectPath = projectPath;
    if (!await this.delay(this.initialDelayMs, generation)) return;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (!this.isCurrentGeneration(generation)) return;
      if (!isProcessActive()) {
        this.log('Game process no longer running, aborting connection');
        return;
      }

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

    if (this.isCurrentGeneration(generation)) {
      console.error(`[SERVER] Failed to connect to game interaction server after ${this.maxAttempts} attempts`);
    }
  }

  disconnect(): void {
    this.connectionGeneration++;
    this.cancelPendingDelay();
    this.destroySocket();
    this.connected = false;
    this.responseBuffer = '';
    this.rejectAllPending({ error: 'Disconnected' });
  }

  rejectAllPending(response: GameResponse): void {
    for (const resolver of this.pendingRequests.values()) resolver(response);
    this.pendingRequests.clear();
  }

  resolveResponse(parsed: unknown): void {
    if (this.pendingRequests.size === 0) return;
    if (!parsed || typeof parsed !== 'object') return;
    const response = parsed as GameResponse;
    let id: number | undefined;
    if (typeof response.id === 'number') {
      if (!this.pendingRequests.has(response.id)) return;
      id = response.id;
    } else {
      id = this.pendingRequests.keys().next().value;
    }
    if (id === undefined) return;
    const resolver = this.pendingRequests.get(id)!;
    this.pendingRequests.delete(id);
    resolver(response);
  }

  async send(command: string, params: Record<string, unknown> = {}, timeoutMs = 10000): Promise<GameResponse> {
    if (!this.connected || !this.socket) {
      throw new Error('Not connected to game interaction server. Is the game running?');
    }

    const id = this.nextRequestId++;
    const payload = JSON.stringify({ command, params, id }) + '\n';
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Game command '${command}' timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pendingRequests.set(id, response => {
        clearTimeout(timeout);
        resolve(response);
      });
      this.socket!.write(payload);
    });
  }

  private connectOnce(attempt: number, generation: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port }, () => {
        if (!this.isCurrentGeneration(generation)) {
          socket.destroy();
          resolve(false);
          return;
        }

        this.connectingSocket = null;
        this.socket = socket;
        this.connected = true;
        this.responseBuffer = '';
        this.pendingRequests.clear();
        this.log(`Connected to game interaction server (attempt ${attempt})`);
        console.error(`[SERVER] Connected to game interaction server on port ${this.port}`);

        socket.on('data', data => {
          if (this.isCurrentSocket(socket, generation)) this.handleData(data);
        });
        socket.on('close', () => {
          this.log('Game interaction connection closed');
          if (!this.isCurrentSocket(socket, generation)) return;
          this.connected = false;
          this.socket = null;
          this.rejectAllPending({ error: 'Connection closed' });
        });
        socket.on('error', err => { this.log(`Game interaction socket error: ${err.message}`); });
        resolve(true);
      });
      this.connectingSocket = socket;
      socket.on('error', error => {
        if (this.isCurrentGeneration(generation)) reject(error);
        else resolve(false);
      });
      socket.on('close', () => {
        if (!this.isCurrentGeneration(generation)) resolve(false);
      });
    });
  }

  private isCurrentGeneration(generation: number): boolean {
    return generation === this.connectionGeneration;
  }

  private isCurrentSocket(socket: Socket, generation: number): boolean {
    return this.isCurrentGeneration(generation) && this.socket === socket;
  }

  private delay(milliseconds: number, generation: number): Promise<boolean> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pendingDelay = null;
        resolve(this.isCurrentGeneration(generation));
      }, milliseconds);
      this.pendingDelay = { timer, resolve };
    });
  }

  private cancelPendingDelay(): void {
    if (this.pendingDelay !== null) {
      clearTimeout(this.pendingDelay.timer);
      this.pendingDelay.resolve(false);
      this.pendingDelay = null;
    }
  }

  private destroySocket(): void {
    const sockets = [this.socket, this.connectingSocket];
    this.socket = null;
    this.connectingSocket = null;
    for (const socket of sockets) socket?.destroy();
  }

  private handleData(data: Buffer): void {
    this.responseBuffer += data.toString();
    while (this.responseBuffer.includes('\n')) {
      const newlinePos = this.responseBuffer.indexOf('\n');
      const line = this.responseBuffer.substring(0, newlinePos).trim();
      this.responseBuffer = this.responseBuffer.substring(newlinePos + 1);
      if (!line) continue;
      try {
        this.resolveResponse(JSON.parse(line));
      } catch {
        this.log(`Failed to parse game response: ${line}`);
      }
    }
  }
}
