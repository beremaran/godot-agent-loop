import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { GameConnection } from '../src/game-connection.js';

const servers: Server[] = [];

async function startServer(): Promise<{ server: Server; port: number; sockets: import('node:net').Socket[] }> {
  const sockets: import('node:net').Socket[] = [];
  const server = createServer(socket => {
    sockets.push(socket);
    let buffer = '';
    socket.on('data', data => {
      buffer += data.toString();
      while (buffer.includes('\n')) {
        const newline = buffer.indexOf('\n');
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (request.method === 'godot.runtime.handshake') {
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '1.0', capabilities: ['runtime-commands', 'godot-json-values'] } })}\n`);
        } else {
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { success: true } })}\n`);
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not bind to a port');
  return { server, port: address.port, sockets };
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => { resolve(); });
  })));
});

describe('GameConnection lifecycle', () => {
  it('exposes project and interaction-server state through lifecycle methods', async () => {
    const connection = new GameConnection({ initialDelayMs: 1000 });
    const connecting = connection.connect('/project', () => true);

    expect(connection.connectedProjectPath).toBe('/project');
    connection.recordInteractionServerInstallation(true);
    expect(connection.consumeInteractionServerOwnership()).toBe(true);
    expect(connection.consumeInteractionServerOwnership()).toBe(false);

    connection.clearConnectedProject();
    expect(connection.connectedProjectPath).toBeNull();
    connection.disconnect();
    await connecting;
  });

  it('cancels an in-progress initial delay when disconnected', async () => {
    const connection = new GameConnection({ initialDelayMs: 1000 });
    const connecting = connection.connect('/project', () => true);

    connection.disconnect();
    await connecting;

    expect(connection.isConnected).toBe(false);
  });

  it('ignores close callbacks from a superseded socket', async () => {
    const { port, sockets } = await startServer();
    const connection = new GameConnection({ port, initialDelayMs: 0, retryDelayMs: 1 });

    await connection.connect('/project', () => true);
    expect(connection.isConnected).toBe(true);

    const reconnecting = connection.connect('/project', () => true);
    await reconnecting;
    expect(sockets).toHaveLength(2);

    // The first server-side socket belongs to the connection that was just superseded.
    // Its delayed close notification must not clear the newer connection state.
    sockets[0].destroy();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(connection.isConnected).toBe(true);

    connection.disconnect();
  });

  it('cancels a pending retry delay when disconnected', async () => {
    const logs: string[] = [];
    const connection = new GameConnection({
      port: 1,
      initialDelayMs: 0,
      retryDelayMs: 1_000,
      maxAttempts: 2,
      log: message => { logs.push(message); },
    });

    const connecting = connection.connect('/project', () => true);
    await waitFor(() => logs.some(message => message.includes('Connection attempt 1/2 failed')));
    connection.disconnect();
    await Promise.race([
      connecting,
      new Promise((_, reject) => setTimeout(() => { reject(new Error('disconnect did not cancel retry')); }, 100)),
    ]);

    expect(connection.isConnected).toBe(false);
  });

  it('negotiates the versioned protocol and sends JSON-RPC command requests', async () => {
    const { port } = await startServer();
    const connection = new GameConnection({ port, initialDelayMs: 0 });

    await connection.connect('/project', () => true);
    const response = await connection.send('click', { x: 10, y: 20 });

    expect(response).toEqual({ jsonrpc: '2.0', id: 2, result: { success: true } });
    connection.disconnect();
  });

  it('requests cooperative cancellation when a runtime request times out', async () => {
    const methods: string[] = [];
    const server = createServer(socket => {
      let buffer = '';
      socket.on('data', data => {
        buffer += data.toString();
        while (buffer.includes('\n')) {
          const newline = buffer.indexOf('\n');
          const request = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          methods.push(request.method);
          if (request.method === 'godot.runtime.handshake') {
            socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '1.0', capabilities: ['runtime-commands', 'godot-json-values'] } })}\n`);
          }
        }
      });
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind to a port');
    const connection = new GameConnection({ port: address.port, initialDelayMs: 0 });

    await connection.connect('/project', () => true);
    await expect(connection.send('wait', {}, 10)).rejects.toThrow('timed out');
    await waitFor(() => methods.includes('godot.runtime.cancel'));

    expect(methods).toEqual(['godot.runtime.handshake', 'godot.runtime.wait', 'godot.runtime.cancel']);
    connection.disconnect();
  });
});
