import { createConnection } from 'node:net';

/* global clearTimeout, process, setTimeout */

const [, , portText, secret] = process.argv;
const port = Number(portText);
if (!Number.isInteger(port) || port < 1 || !secret) {
  throw new Error('Usage: node authoring-session-client.mjs <port> <secret>');
}

let buffer = '';
let nextId = 1;
const pending = new Map();

function connect() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const attempt = () => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { resolve(socket); });
      socket.once('error', error => {
        socket.destroy();
        if (Date.now() >= deadline) reject(error);
        else setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

const socket = await connect();
socket.setEncoding('utf8');
socket.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const newline = buffer.indexOf('\n');
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const response = JSON.parse(line);
    pending.get(response.id)?.(response);
    pending.delete(response.id);
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 10_000);
    pending.set(id, response => {
      clearTimeout(timeout);
      resolve(response);
    });
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

const handshake = await request('godot.runtime.handshake', {
  protocolVersion: '1.0',
  secret,
});
if (handshake.error || !handshake.result.capabilities.includes('authoring-commands')) {
  throw new Error(`Authoring capability missing: ${JSON.stringify(handshake)}`);
}

const created = await request('godot.runtime.authoring_create_scene', {
  scene_path: 'scenes/session_created.tscn',
  root_node_type: 'Node2D',
});
if (created.error || created.result.success !== true || created.result.operation !== 'create_scene') {
  throw new Error(`Authoring success response is invalid: ${JSON.stringify(created)}`);
}

const failed = await request('godot.runtime.authoring_create_scene', {
  scene_path: 'scenes/session_invalid.tscn',
  root_node_type: 'NotARealClass',
});
if (failed.error?.code !== -32000 || failed.error?.data?.reason !== 'authoring_operation_failed') {
  throw new Error(`Authoring failure response is invalid: ${JSON.stringify(failed)}`);
}

const runtime = await request('godot.runtime.os_info', {});
if (runtime.error || typeof runtime.result?.os_name !== 'string') {
  throw new Error(`Runtime command failed after authoring failure: ${JSON.stringify(runtime)}`);
}

socket.end();
