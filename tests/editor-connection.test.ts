// @test-kind: unit
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EditorBridgeCompatibilityError,
  EditorConnection,
  EditorRequestTimeoutError,
} from '../src/editor-connection.js';

const servers: Server[] = [];
const connections: EditorConnection[] = [];

async function bridge(
  respond: (request: Record<string, unknown>, socket: Socket) => void,
): Promise<{ port: number; requests: Record<string, unknown>[] }> {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        buffer = buffer.slice(newline + 1);
        requests.push(request);
        respond(request, socket);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server address');
  return { port: address.port, requests };
}

function reply(socket: Socket, request: Record<string, unknown>, result: Record<string, unknown>): void {
  socket.write(`${JSON.stringify({ id: request.id, ...result })}\n`);
}

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.disconnect();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => { resolve(); }))));
});

describe('EditorConnection protocol handshake', () => {
  it('authenticates and negotiates compatibility before the first command', async () => {
    const testBridge = await bridge((request, socket) => {
      if (request.command === 'handshake') reply(socket, request, { success: true, protocol_version: '1' });
      else reply(socket, request, { success: true, command: request.command });
    });
    const connection = new EditorConnection({
      port: testBridge.port, secret: 'secret', protocolVersion: '1', serverVersion: '1.0.0',
    });
    connections.push(connection);

    await expect(connection.send('inspect')).resolves.toMatchObject({ success: true, command: 'inspect' });
    await expect(connection.send('driver_state')).resolves.toMatchObject({ success: true, command: 'driver_state' });
    expect(testBridge.requests.map(request => request.command)).toEqual(['handshake', 'inspect', 'driver_state']);
    expect(testBridge.requests[0]).toMatchObject({
      secret: 'secret', params: { protocol_version: '1', server_version: '1.0.0' },
    });
  });

  it('throws a specific error and reconnects on protocol mismatch', async () => {
    const testBridge = await bridge((request, socket) => {
      reply(socket, request, { error: 'incompatible_protocol', protocol_version: '2' });
    });
    const connection = new EditorConnection({ port: testBridge.port, secret: 'secret', protocolVersion: '1' });
    connections.push(connection);

    await expect(connection.send('inspect')).rejects.toEqual(expect.any(EditorBridgeCompatibilityError));
    await expect(connection.send('inspect')).rejects.toThrow(/server 1, addon 2/);
    expect(testBridge.requests.map(request => request.command)).toEqual(['handshake', 'handshake']);
  });

  it('treats handshake errors and missing versions as incompatibility', async () => {
    const testBridge = await bridge((request, socket) => {
      reply(socket, request, { error: 'authentication_required' });
    });
    const connection = new EditorConnection({ port: testBridge.port, secret: 'wrong' });
    connections.push(connection);
    await expect(connection.send('inspect')).rejects.toThrow(/addon missing/);
  });

  it('keeps the socket usable after one request times out', async () => {
    const testBridge = await bridge((request, socket) => {
      if (request.command === 'handshake') reply(socket, request, { success: true, protocol_version: '2' });
      if (request.command === 'inspect') reply(socket, request, { success: true, command: request.command });
    });
    const connection = new EditorConnection({ port: testBridge.port, secret: 'secret' });
    connections.push(connection);

    await expect(connection.send('driver_state', {}, 10)).rejects.toEqual(expect.any(EditorRequestTimeoutError));
    await expect(connection.send('inspect')).resolves.toMatchObject({ success: true, command: 'inspect' });
    expect(testBridge.requests.map(request => request.command)).toEqual(['handshake', 'driver_state', 'inspect']);
  });
});
