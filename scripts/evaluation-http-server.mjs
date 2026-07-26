#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { GodotServer } from '../build/index.js';

const host = '127.0.0.1';
const configuredPort = Number(process.env.GODOT_MCP_EVAL_HTTP_PORT ?? 0);
if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort >= 65536) {
  throw new Error('GODOT_MCP_EVAL_HTTP_PORT must be an integer from 0 through 65535.');
}

const sessions = new Map();

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        reject(new Error('Evaluation HTTP request exceeds the 1 MiB limit.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error('Evaluation HTTP request body is not valid JSON.', { cause: error }));
      }
    });
    request.on('error', reject);
  });
}

async function createSession(request, response, parsedBody) {
  if (parsedBody?.method !== 'initialize') {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'missing MCP session; initialize first' }));
    return;
  }
  let sessionRecord;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: sessionId => {
      sessionRecord.sessionId = sessionId;
      sessions.set(sessionId, sessionRecord);
    },
    onsessionclosed: sessionId => {
      const record = sessions.get(sessionId);
      sessions.delete(sessionId);
      if (record) void record.server.close().catch(() => undefined);
    },
  });
  const server = new GodotServer({
    manageProcessLifecycle: false,
    strictPathValidation: process.env.GODOT_MCP_EVAL_STRICT_GODOT !== 'false',
  });
  sessionRecord = { sessionId: null, server, transport };
  await server.connect(transport);
  await transport.handleRequest(request, response, parsedBody);
}

let expectedAuthority = '';
const httpServer = createServer(async (request, response) => {
  const authority = request.headers.host ?? '';
  const origin = request.headers.origin;
  if (authority !== expectedAuthority
    || (origin !== undefined && origin !== `http://${expectedAuthority}`)) {
    response.writeHead(403, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'loopback authority or origin rejected' }));
    return;
  }

  const url = new URL(request.url ?? '/', `http://${authority}`);
  if (url.pathname === '/health' && request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname !== '/mcp') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  try {
    const sessionId = request.headers['mcp-session-id'];
    const record = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    if (record) {
      await record.transport.handleRequest(request, response);
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'missing or invalid MCP session' }));
      return;
    }
    const parsedBody = await readJsonBody(request);
    await createSession(request, response, parsedBody);
  } catch (error) {
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
    if (!response.writableEnded) {
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  }
});

await new Promise((resolve, reject) => {
  httpServer.once('error', reject);
  httpServer.listen(configuredPort, host, resolve);
});
const address = httpServer.address();
if (!address || typeof address === 'string') throw new Error('Evaluation HTTP server did not bind a TCP address.');
expectedAuthority = `${host}:${address.port}`;

const url = `http://${expectedAuthority}/mcp`;
process.stdout.write(`${JSON.stringify({ url, pid: process.pid })}\n`);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([...sessions.values()].map(record => record.server.close().catch(() => undefined)));
  sessions.clear();
  await new Promise(resolve => httpServer.close(resolve));
}

process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
