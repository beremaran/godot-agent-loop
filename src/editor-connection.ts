import { createConnection, type Socket } from 'node:net';

export interface EditorConnectionOptions {
  port: number;
  secret: string;
}

/** Authenticated newline-delimited bridge to the optional EditorPlugin. */
export class EditorConnection {
  private socket: Socket | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, (value: Record<string, unknown>) => void>();

  constructor(private readonly options: EditorConnectionOptions) {}

  async send(command: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    await this.ensureConnected(timeoutMs);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Editor request '${command}' timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, result => { clearTimeout(timer); resolve(result); });
      this.socket!.write(`${JSON.stringify({ id, command, params, secret: this.options.secret })}\n`);
    });
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
    this.buffer = '';
    for (const resolve of this.pending.values()) { resolve({ error: 'editor_disconnected' }); }
    this.pending.clear();
  }

  private async ensureConnected(timeoutMs: number): Promise<void> {
    if (this.socket) return;
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: this.options.port });
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Editor bridge connection timed out')); }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        this.socket = socket;
        socket.on('data', data => { this.receive(data.toString('utf8')); });
        socket.on('close', () => { if (this.socket === socket) this.disconnect(); });
        socket.on('error', () => undefined);
        resolve();
      });
      socket.once('error', error => { clearTimeout(timer); reject(error); });
    });
  }

  private receive(data: string): void {
    this.buffer += data;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const id = parsed.id;
        if (typeof id === 'number') this.pending.get(id)?.(parsed);
        if (typeof id === 'number') this.pending.delete(id);
      } catch { /* malformed bridge data is ignored; the request timeout is authoritative */ }
    }
  }
}
