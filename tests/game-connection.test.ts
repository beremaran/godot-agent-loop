import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { GameConnection } from '../src/game-connection.js';

const servers: Server[] = [];

async function startServer(): Promise<{ server: Server; port: number }> {
  const server = createServer(socket => {
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
  return { server, port: address.port };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => { resolve(); });
  })));
});

describe('GameConnection lifecycle', () => {
  it('cancels an in-progress initial delay when disconnected', async () => {
    const connection = new GameConnection({ initialDelayMs: 1000 });
    const connecting = connection.connect('/project', () => true);

    connection.disconnect();
    await connecting;

    expect(connection.connected).toBe(false);
    expect(connection.socket).toBeNull();
  });

  it('ignores close callbacks from a superseded socket', async () => {
    const { port } = await startServer();
    const connection = new GameConnection({ port, initialDelayMs: 0, retryDelayMs: 1 });

    await connection.connect('/project', () => true);
    expect(connection.connected).toBe(true);

    const reconnecting = connection.connect('/project', () => true);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(connection.connected).toBe(true);

    await reconnecting;
    connection.disconnect();
  });

  it('negotiates the versioned protocol and sends JSON-RPC command requests', async () => {
    const { port } = await startServer();
    const connection = new GameConnection({ port, initialDelayMs: 0 });

    await connection.connect('/project', () => true);
    const response = await connection.send('click', { x: 10, y: 20 });

    expect(response).toEqual({ jsonrpc: '2.0', id: 2, result: { success: true } });
    connection.disconnect();
  });
});
