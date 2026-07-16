import { createConnection, type Socket } from 'node:net';
import { EDITOR_BRIDGE_PROTOCOL_VERSION } from './editor-bridge-protocol.js';
import { abortError, throwIfCancelled } from './execution-context.js';

export interface EditorConnectionOptions {
  port: number;
  secret: string;
  protocolVersion?: string;
  serverVersion?: string;
}

export class EditorBridgeCompatibilityError extends Error {}

export class EditorRequestTimeoutError extends Error {}

/** Authenticated newline-delimited bridge to the optional EditorPlugin. */
export class EditorConnection {
  private socket: Socket | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, (value: Record<string, unknown>) => void>();
  private connecting: Promise<void> | null = null;
  private handshaking: Promise<Record<string, unknown>> | null = null;

  constructor(private readonly options: EditorConnectionOptions) {}

  async send(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10_000,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    throwIfCancelled(signal);
    await this.ensureConnected(timeoutMs, signal);
    throwIfCancelled(signal);
    if (command === 'handshake') return this.authenticate(timeoutMs, signal);
    await this.authenticate(timeoutMs, signal);
    // Editor mutations are atomic after the request is written. Honour a
    // cancellation received while connecting/authenticating, but once sent let
    // Godot finish and report its single authoritative outcome.
    throwIfCancelled(signal);
    return this.request(command, params, timeoutMs);
  }

  async authenticate(timeoutMs = 10_000, signal?: AbortSignal): Promise<Record<string, unknown>> {
    throwIfCancelled(signal);
    await this.ensureConnected(timeoutMs, signal);
    throwIfCancelled(signal);
    if (!this.handshaking) {
      const expected = this.options.protocolVersion ?? EDITOR_BRIDGE_PROTOCOL_VERSION;
      this.handshaking = this.request('handshake', {
        protocol_version: expected,
        server_version: this.options.serverVersion ?? 'unknown',
      }, timeoutMs).then(result => {
        if (result.error || result.protocol_version !== expected) {
          const actual = typeof result.protocol_version === 'string' ? result.protocol_version : 'missing';
          throw new EditorBridgeCompatibilityError(
            `Godot Agent Loop editor protocol is incompatible: server ${expected}, addon ${actual}`,
          );
        }
        return result;
      });
    }
    try {
      return await this.handshaking;
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  private request(command: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EditorRequestTimeoutError(`Editor request '${command}' timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, result => { clearTimeout(timer); resolve(result); });
      this.socket!.write(`${JSON.stringify({ id, command, params, secret: this.options.secret })}\n`);
    });
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
    this.buffer = '';
    this.handshaking = null;
    for (const resolve of this.pending.values()) { resolve({ error: 'editor_disconnected' }); }
    this.pending.clear();
  }

  private async ensureConnected(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    if (this.socket) return;
    if (this.connecting) {
      await this.connecting;
      throwIfCancelled(signal);
      return;
    }
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: this.options.port });
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const timer = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new Error('Editor bridge connection timed out'));
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        cleanup();
        socket.destroy();
        reject(abortError(signal?.reason));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      socket.once('connect', () => {
        clearTimeout(timer);
        cleanup();
        this.socket = socket;
        socket.on('data', data => { this.receive(data.toString('utf8')); });
        socket.on('close', () => { if (this.socket === socket) this.disconnect(); });
        socket.on('error', () => undefined);
        resolve();
      });
      socket.once('error', error => { clearTimeout(timer); cleanup(); reject(error); });
    });
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
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
