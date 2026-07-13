// @test-kind: e2e
import { appendFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTempProject,
  freePort,
  startServer,
  type E2EServer,
} from './helpers/harness.js';

let server: E2EServer | null = null;
let peerServer: E2EServer | null = null;
let httpFixture: Awaited<ReturnType<typeof startHttpFixture>> | null = null;

afterEach(async () => {
  for (const game of [peerServer, server]) {
    if (game) await game.close();
  }
  server = null;
  peerServer = null;
  if (httpFixture) {
    const fixture = httpFixture;
    httpFixture = null;
    await fixture.close();
  }
});

function payload(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

async function evalResult(game: E2EServer, code: string): Promise<unknown> {
  const result = await game.call('game_eval', { code });
  expect(result.isError, result.text).toBe(false);
  return payload(result.text).result;
}

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  let latest = await read();
  for (let attempt = 0; attempt < 100 && !accept(latest); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25));
    latest = await read();
  }
  expect(accept(latest), JSON.stringify(latest)).toBe(true);
  return latest;
}

async function startGame(project = createTempProject()): Promise<E2EServer> {
  const game = await startServer({ project, allowPrivileged: true });
  const started = await game.call('run_project', { projectPath: project.projectPath });
  expect(started.isError, started.text).toBe(false);
  await game.waitForGameConnection();
  return game;
}

interface HttpRequestRecord {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function startHttpFixture(): Promise<{
  port: number;
  requests: HttpRequestRecord[];
  close(): Promise<void>;
}> {
  const requests: HttpRequestRecord[] = [];
  const sockets = new Set<Socket>();
  const fixture: HttpServer = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const record: HttpRequestRecord = {
        method: request.method ?? '', url: request.url ?? '', headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(record);
      const respond = () => {
        response.setHeader('X-Fixture', 'local-http');
        if (record.url === '/large') {
          response.end(Buffer.alloc(4 * 1024 * 1024 + 1, 0x61));
          return;
        }
        response.statusCode = record.url === '/status' ? 418 : 200;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ method: record.method, body: record.body, header: record.headers['x-e2e'] ?? null }));
      };
      if (record.url === '/slow') setTimeout(respond, 200);
      else respond();
    });
  });
  fixture.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    fixture.once('error', reject);
    fixture.listen(0, '127.0.0.1', resolve);
  });
  const address = fixture.address();
  if (address === null || typeof address === 'string') throw new Error('HTTP fixture did not bind');
  return {
    port: address.port,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => fixture.close(() => {
        resolve();
      }));
    },
  };
}

function rpcProject(name: string): ReturnType<typeof createTempProject> {
  const project = createTempProject({ name });
  appendFileSync(`${project.projectPath}/main.gd`, [
    '',
    'var rpc_calls: Array = []',
    '',
    '',
    'func record_rpc(value: int, label: String) -> void:',
    '\trpc_calls.append({"value": value, "label": label, "sender": multiplayer.get_remote_sender_id()})',
    '',
    '',
    'func unconfigured_rpc(value: int) -> void:',
    '\trpc_calls.append({"value": value, "label": "unconfigured"})',
    '',
  ].join('\n'));
  return project;
}

async function rpcCalls(game: E2EServer): Promise<Record<string, unknown>[]> {
  return await evalResult(game, 'return get_tree().root.get_node("Main").get("rpc_calls")') as Record<string, unknown>[];
}

describe('runtime remote I/O tools through MCP', () => {
  it('game_http_request covers local methods, headers, status, timeout recovery, limits, and validation', async () => {
    httpFixture = await startHttpFixture();
    server = await startGame();
    const baseUrl = `http://127.0.0.1:${httpFixture.port}`;

    const get = await server.call('game_http_request', {
      url: `${baseUrl}/echo`, method: 'GET', headers: { 'X-E2E': 'request-header' }, timeout: 2,
    });
    expect(get.isError, get.text).toBe(false);
    expect(payload(get.text)).toMatchObject({ status_code: 200, result: 0, bytes: expect.any(Number) });
    expect(payload(get.text).headers).toEqual(expect.arrayContaining([expect.stringMatching(/X-Fixture: local-http/i)]));
    expect(JSON.parse(String(payload(get.text).body))).toEqual({ method: 'GET', body: '', header: 'request-header' });

    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      const response = await server.call('game_http_request', {
        url: `${baseUrl}/echo`, method, body: `${method}-body`, timeout: 2,
      });
      expect(response.isError, response.text).toBe(false);
      expect(JSON.parse(String(payload(response.text).body))).toMatchObject({ method, body: `${method}-body` });
    }
    expect(httpFixture.requests.map(request => request.method)).toEqual(['GET', 'POST', 'PUT', 'DELETE']);

    const status = await server.call('game_http_request', { url: `${baseUrl}/status`, timeout: 2 });
    expect(payload(status.text)).toMatchObject({ status_code: 418, success: true });
    const timedOut = await server.call('game_http_request', { url: `${baseUrl}/slow`, timeout: 0.05 });
    expect(timedOut.isError).toBe(true);
    expect(timedOut.text).toMatch(/did not complete successfully/i);
    expect((await server.call('game_http_request', { url: `${baseUrl}/echo`, timeout: 2 })).isError).toBe(false);

    const oversized = await server.call('game_http_request', { url: `${baseUrl}/large`, timeout: 2 });
    expect(oversized.isError).toBe(true);
    expect(oversized.text).toMatch(/payload limit/i);
    const badHeaders = await server.call('game_http_request', {
      url: `${baseUrl}/echo`, headers: { Valid: { nested: false } },
    });
    expect(badHeaders.isError).toBe(true);
    expect(badHeaders.text).toMatch(/header names and values must be strings/i);
    await expect(server.client.callTool({
      name: 'game_http_request', arguments: { url: 'file:///etc/passwd' },
    })).rejects.toThrow(/must match/i);
  });

  it('game_rpc covers real two-process peers, varargs, targets, local sync, authority, and failures', async () => {
    const firstProject = rpcProject('rpc server');
    const secondProject = rpcProject('rpc client');
    [server, peerServer] = await Promise.all([startGame(firstProject), startGame(secondProject)]);
    const port = await freePort();
    expect((await server.call('game_multiplayer', { action: 'create_server', port })).isError).toBe(false);
    expect((await peerServer.call('game_multiplayer', {
      action: 'create_client', address: '127.0.0.1', port,
    })).isError).toBe(false);
    await waitFor(
      async () => payload((await server!.call('game_multiplayer', { action: 'status' })).text),
      state => state.connected === true && state.peer_count === 1,
    );
    const clientState = await waitFor(
      async () => payload((await peerServer!.call('game_multiplayer', { action: 'status' })).text),
      state => state.connected === true,
    );
    const clientId = clientState.unique_id as number;
    expect(clientId).not.toBe(1);

    const anyPeerConfig = {
      nodePath: '/root/Main', action: 'configure', method: 'record_rpc',
      mode: 'any_peer', sync: 'call_remote', transferMode: 'reliable', channel: 2,
    };
    expect((await server.call('game_rpc', anyPeerConfig)).isError).toBe(false);
    expect((await peerServer.call('game_rpc', anyPeerConfig)).isError).toBe(false);
    const targeted = await peerServer.call('game_rpc', {
      nodePath: '/root/Main', action: 'call', method: 'record_rpc', peerId: 1, args: [7, 'client-to-server'],
    });
    expect(targeted.isError, targeted.text).toBe(false);
    expect(payload(targeted.text)).toMatchObject({ peer_id: 1, argument_count: 2 });
    await waitFor(() => rpcCalls(server!), calls => calls.length === 1);
    expect((await rpcCalls(server))[0]).toMatchObject({ value: 7, label: 'client-to-server', sender: clientId });

    const localConfig = { ...anyPeerConfig, sync: 'call_local' };
    await server.call('game_rpc', localConfig);
    await peerServer.call('game_rpc', localConfig);
    expect((await server.call('game_rpc', {
      nodePath: '/root/Main', action: 'call', method: 'record_rpc', peerId: clientId, args: [8, 'server-local'],
    })).isError).toBe(false);
    await waitFor(() => rpcCalls(server!), calls => calls.length === 2);
    await waitFor(() => rpcCalls(peerServer!), calls => calls.length === 1);
    expect((await rpcCalls(server))[1]).toMatchObject({ value: 8, label: 'server-local', sender: 0 });
    expect((await rpcCalls(peerServer))[0]).toMatchObject({ value: 8, label: 'server-local', sender: 1 });

    const authorityConfig = { ...anyPeerConfig, mode: 'authority', sync: 'call_remote' };
    await server.call('game_rpc', authorityConfig);
    await peerServer.call('game_rpc', authorityConfig);
    const rejected = await peerServer.call('game_rpc', {
      nodePath: '/root/Main', action: 'call', method: 'record_rpc', peerId: 1, args: [9, 'rejected-client'],
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toMatch(/multiplayer authority/i);
    await server.call('game_wait', { frames: 10 });
    expect((await rpcCalls(server)).map(call => call.label)).not.toContain('rejected-client');
    expect((await server.call('game_rpc', {
      nodePath: '/root/Main', action: 'call', method: 'record_rpc', peerId: clientId, args: [10, 'authority-server'],
    })).isError).toBe(false);
    await waitFor(() => rpcCalls(peerServer!), calls => calls.length === 2);
    expect((await rpcCalls(peerServer))[1]).toMatchObject({ value: 10, label: 'authority-server', sender: 1 });

    const missingMethod = await server.call('game_rpc', {
      nodePath: '/root/Main', action: 'call', method: 'missing_rpc', args: [],
    });
    expect(missingMethod.isError).toBe(true);
    expect(missingMethod.text).toMatch(/method not found/i);
    const unconfigured = await server.call('game_rpc', {
      nodePath: '/root/Main', action: 'call', method: 'unconfigured_rpc', args: [1],
    });
    expect(unconfigured.isError).toBe(true);
    expect(unconfigured.text).toMatch(/RPC call failed/i);
    await expect(server.client.callTool({
      name: 'game_rpc', arguments: {
        nodePath: '/root/Main', action: 'call', method: 'record_rpc', args: Array(65).fill(null),
      },
    })).rejects.toThrow(/at most 64 items/i);
    expect((await peerServer.call('game_multiplayer', { action: 'disconnect' })).isError).toBe(false);
    expect((await server.call('game_multiplayer', { action: 'disconnect' })).isError).toBe(false);
  });
});
