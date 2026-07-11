import { createConnection, type Socket } from 'net';

export interface GameConnectionOptions {
  port?: number;
  host?: string;
  initialDelayMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  log?: (message: string) => void;
}

type ResponseResolver = (value: any) => void;

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
    this.projectPath = projectPath;
    await new Promise(resolve => setTimeout(resolve, this.initialDelayMs));

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (!isProcessActive()) {
        this.log('Game process no longer running, aborting connection');
        return;
      }

      try {
        await this.connectOnce(attempt);
        return;
      } catch {
        this.log(`Connection attempt ${attempt}/${this.maxAttempts} failed, retrying in ${this.retryDelayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, this.retryDelayMs));
      }
    }

    console.error(`[SERVER] Failed to connect to game interaction server after ${this.maxAttempts} attempts`);
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.responseBuffer = '';
    this.rejectAllPending({ error: 'Disconnected' });
  }

  rejectAllPending(response: any): void {
    for (const resolver of this.pendingRequests.values()) resolver(response);
    this.pendingRequests.clear();
  }

  resolveResponse(parsed: any): void {
    if (this.pendingRequests.size === 0) return;
    let id: number | undefined;
    if (parsed && typeof parsed.id === 'number') {
      if (!this.pendingRequests.has(parsed.id)) return;
      id = parsed.id;
    } else {
      id = this.pendingRequests.keys().next().value;
    }
    if (id === undefined) return;
    const resolver = this.pendingRequests.get(id)!;
    this.pendingRequests.delete(id);
    resolver(parsed);
  }

  async send(command: string, params: Record<string, any> = {}, timeoutMs = 10000): Promise<any> {
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

  private connectOnce(attempt: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port }, () => {
        this.socket = socket;
        this.connected = true;
        this.responseBuffer = '';
        this.pendingRequests.clear();
        this.log(`Connected to game interaction server (attempt ${attempt})`);
        console.error(`[SERVER] Connected to game interaction server on port ${this.port}`);

        socket.on('data', data => { this.handleData(data); });
        socket.on('close', () => {
          this.log('Game interaction connection closed');
          this.connected = false;
          this.socket = null;
          this.rejectAllPending({ error: 'Connection closed' });
        });
        socket.on('error', err => { this.log(`Game interaction socket error: ${err.message}`); });
        resolve();
      });
      socket.on('error', reject);
    });
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
