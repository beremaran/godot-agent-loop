// @test-kind: e2e
import { createHash } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { freePort, startServer, type E2EServer } from './helpers/harness.js';

let server: E2EServer | null = null;
let websocketFixture: Awaited<ReturnType<typeof startWebSocketFixture>> | null = null;

afterEach(async () => {
  if (server) {
    const active = server;
    server = null;
    await active.close();
  }
  if (websocketFixture) {
    const active = websocketFixture;
    websocketFixture = null;
    await active.close();
  }
});

function payload(text: string): unknown {
  return JSON.parse(text) as unknown;
}

async function startedGame(): Promise<E2EServer> {
  server = await startServer({ allowPrivileged: true });
  const started = await server.call('run_project', { projectPath: server.projectPath });
  expect(started.isError, started.text).toBe(false);
  await server.waitForGameConnection();
  return server;
}

async function evalResult(game: E2EServer, code: string): Promise<unknown> {
  const result = await game.call('game_eval', { code });
  expect(result.isError, result.text).toBe(false);
  return (payload(result.text) as { result: unknown }).result;
}

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  let latest = await read();
  for (let attempt = 0; attempt < 80 && !accept(latest); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25));
    latest = await read();
  }
  expect(accept(latest), JSON.stringify(latest)).toBe(true);
  return latest;
}

function serverFrame(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  if (body.length >= 126) throw new Error('Fixture frame is unexpectedly large');
  return Buffer.concat([Buffer.from([0x81, body.length]), body]);
}

async function startWebSocketFixture(): Promise<{
  port: number;
  messages: string[];
  close(): Promise<void>;
}> {
  const messages: string[] = [];
  const sockets = new Set<Socket>();
  const tcpServer = createServer(socket => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on('close', () => sockets.delete(socket));
    // macOS reports a peer disappearing during fixture teardown as ECONNRESET.
    // The protocol assertions already prove active socket failures; teardown
    // must still consume the socket error event so Node does not treat it as an
    // uncaught exception after the test has completed.
    socket.on('error', () => sockets.delete(socket));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const headers = buffer.subarray(0, headerEnd).toString('utf8');
        const key = /^Sec-WebSocket-Key:\s*(.+)$/im.exec(headers)?.[1]?.trim();
        if (!key) {
          socket.destroy(new Error('Missing WebSocket key'));
          return;
        }
        const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        socket.write([
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          '',
          '',
        ].join('\r\n'));
        upgraded = true;
        buffer = buffer.subarray(headerEnd + 4);
        socket.write(serverFrame('server-ready'));
      }

      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 0x0f;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        }
        const masked = (buffer[1] & 0x80) !== 0;
        const required = offset + (masked ? 4 : 0) + length;
        if (buffer.length < required) return;
        let body = Buffer.from(buffer.subarray(offset + (masked ? 4 : 0), required));
        if (masked) {
          const mask = buffer.subarray(offset, offset + 4);
          body = body.map((byte, index) => byte ^ mask[index % 4]);
        }
        buffer = buffer.subarray(required);
        if (opcode === 0x8) {
          socket.end(Buffer.from([0x88, 0x00]));
          return;
        }
        if (opcode !== 0x1) continue;
        const text = body.toString('utf8');
        messages.push(text);
        socket.write(serverFrame(`echo:${text}`));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    tcpServer.once('error', reject);
    tcpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = tcpServer.address();
  if (address === null || typeof address === 'string') throw new Error('WebSocket fixture did not bind TCP');
  return {
    port: address.port,
    messages,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => tcpServer.close(() => {
        resolve();
      }));
    },
  };
}

function externalPeerCode(role: 'client' | 'server', port: number, name: string): string {
  return [
    `var peer := ENetMultiplayerPeer.new()`,
    `var error := peer.create_${role}(${role === 'client' ? `"127.0.0.1", ${port}` : `${port}, 4`})`,
    'if error != OK:',
    '\treturn error',
    'var script := GDScript.new()',
    'script.source_code = "extends Node\\nvar peer: ENetMultiplayerPeer\\nfunc _process(_delta: float) -> void:\\n\\tif peer != null:\\n\\t\\tpeer.poll()\\n"',
    'if script.reload() != OK:',
    '\treturn -1000',
    'var holder := Node.new()',
    `holder.name = "${name}"`,
    'holder.set_script(script)',
    'holder.set("peer", peer)',
    'get_tree().root.get_node("Main").add_child(holder)',
    'return OK',
  ].join('\n');
}

describe('runtime networking tools through MCP', () => {
  it('game_websocket covers real connect/send/receive/status/disconnect and timeouts', async () => {
    websocketFixture = await startWebSocketFixture();
    const game = await startedGame();

    const connected = await game.call('game_websocket', {
      action: 'connect', url: `ws://127.0.0.1:${websocketFixture.port}/fixture`, timeout: 3,
    });
    expect(connected.isError, connected.text).toBe(false);
    expect(payload(connected.text)).toMatchObject({ status: 'open' });
    const status = await game.call('game_websocket', { action: 'status' });
    expect(payload(status.text)).toMatchObject({ status: 'open' });

    const greeting = await game.call('game_websocket', { action: 'receive', timeout: 2 });
    expect(greeting.isError, greeting.text).toBe(false);
    expect(payload(greeting.text)).toMatchObject({ message: 'server-ready', bytes: 12 });
    expect((await game.call('game_websocket', { action: 'send', message: 'hello-godot' })).isError).toBe(false);
    const echoed = await game.call('game_websocket', { action: 'receive', timeout: 2 });
    expect(payload(echoed.text)).toMatchObject({ message: 'echo:hello-godot' });
    expect(websocketFixture.messages).toEqual(['hello-godot']);

    const timeout = await game.call('game_websocket', { action: 'receive', timeout: 0.05 });
    expect(timeout.isError).toBe(true);
    expect(timeout.text).toMatch(/timed out/i);
    expect((await game.call('game_websocket', { action: 'disconnect' })).isError).toBe(false);
    expect(payload((await game.call('game_websocket', { action: 'status' })).text)).toMatchObject({ status: 'disconnected' });

    const noMessage = await game.call('game_websocket', { action: 'send' });
    expect(noMessage.isError).toBe(true);
    expect(noMessage.text).toMatch(/message is required/i);
  });

  it('game_multiplayer covers real ENet server/client peers, conflicts, status, and disconnects', async () => {
    const game = await startedGame();
    const serverPort = await freePort();
    expect((await game.call('game_multiplayer', {
      action: 'create_server', port: serverPort, maxClients: 4,
    })).isError).toBe(false);
    expect(await evalResult(game, externalPeerCode('client', serverPort, 'ExternalClient'))).toBe(0);

    const serverState = await waitFor(
      async () => payload((await game.call('game_multiplayer', { action: 'status' })).text) as Record<string, unknown>,
      state => state.connected === true && state.is_server === true && state.peer_count === 1,
    );
    expect(serverState).toMatchObject({ status: 'connected', unique_id: 1 });
    expect(await evalResult(game, [
      'var peer := get_tree().root.get_node("Main/ExternalClient").get("peer") as ENetMultiplayerPeer',
      'return peer.get_connection_status()',
    ].join('\n'))).toBe(2);

    expect((await game.call('game_multiplayer', { action: 'disconnect' })).isError).toBe(false);
    expect(payload((await game.call('game_multiplayer', { action: 'status' })).text)).toMatchObject({ connected: false, status: 'disconnected', peer_count: 0 });
    await waitFor(
      async () => evalResult(game, [
        'var peer := get_tree().root.get_node("Main/ExternalClient").get("peer") as ENetMultiplayerPeer',
        'return peer.get_connection_status()',
      ].join('\n')) as Promise<number>,
      state => state === 0,
    );
    expect(await evalResult(game, [
      'var holder := get_tree().root.get_node("Main/ExternalClient")',
      '(holder.get("peer") as ENetMultiplayerPeer).close()',
      'holder.queue_free()',
      'return true',
    ].join('\n'))).toBe(true);

    const clientPort = await freePort();
    expect(await evalResult(game, externalPeerCode('server', clientPort, 'ExternalServer'))).toBe(0);
    const conflict = await game.call('game_multiplayer', {
      action: 'create_server', port: clientPort, maxClients: 2,
    });
    expect(conflict.isError).toBe(true);
    expect(conflict.text).toMatch(/Failed to create multiplayer server/i);
    expect((await game.call('game_multiplayer', {
      action: 'create_client', address: '127.0.0.1', port: clientPort,
    })).isError).toBe(false);
    const clientState = await waitFor(
      async () => payload((await game.call('game_multiplayer', { action: 'status' })).text) as Record<string, unknown>,
      state => state.connected === true && state.is_server === false,
    );
    expect(clientState.status).toBe('connected');
    expect(clientState.unique_id).not.toBe(1);
    expect((await game.call('game_multiplayer', { action: 'disconnect' })).isError).toBe(false);
    expect(await evalResult(game, [
      'var holder := get_tree().root.get_node("Main/ExternalServer")',
      '(holder.get("peer") as ENetMultiplayerPeer).close()',
      'holder.queue_free()',
      'return true',
    ].join('\n'))).toBe(true);
  });
});
