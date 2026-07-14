import { createConnection } from 'node:net';

/* global clearTimeout, process, setTimeout */

const [, , portText, secret, mode = 'headed'] = process.argv;
const port = Number(portText);
if (!Number.isInteger(port) || port < 1 || !secret || !['headed', 'expect-no-render'].includes(mode)) {
  throw new Error('Usage: node authoring-session-client.mjs <port> <secret> [headed|expect-no-render]');
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

if (mode === 'expect-no-render') {
  if (handshake.result.capabilities.includes('rendering-context')) {
    throw new Error(`Headless session advertised a rendering context: ${JSON.stringify(handshake)}`);
  }
  const screenshot = await request('godot.runtime.screenshot', {});
  if (screenshot.error?.code !== -32000
    || screenshot.error?.data?.reason !== 'rendering_context_unavailable') {
    throw new Error(`Headless screenshot did not fail fast: ${JSON.stringify(screenshot)}`);
  }
  socket.end();
  process.exitCode = 0;
} else {
  if (!handshake.result.capabilities.includes('rendering-context')) {
    throw new Error(`Rendering capability missing: ${JSON.stringify(handshake)}`);
  }

  const timing = await request('godot.runtime.time_scale', { action: 'get' });
  if (timing.error || timing.result.time_scale !== 1 || timing.result.fixed_fps !== 60) {
    throw new Error(`Deterministic session timing is invalid: ${JSON.stringify(timing)}`);
  }
  const scaled = await request('godot.runtime.time_scale', { action: 'set', time_scale: 0.5 });
  if (scaled.error || scaled.result.time_scale !== 0.5 || scaled.result.fixed_fps !== 60) {
    throw new Error(`Session time-scale control failed: ${JSON.stringify(scaled)}`);
  }

  const created = await request('godot.runtime.authoring_create_scene', {
    scene_path: 'scenes/session_created.tscn',
    root_node_type: 'Node2D',
  });
  if (created.error || created.result.success !== true || created.result.operation !== 'create_scene'
    || !created.result.stdout.includes('Scene created successfully')) {
    throw new Error(`Authoring success response is invalid: ${JSON.stringify(created)}`);
  }

  const attached = await request('godot.runtime.authoring_attach_script', {
    scene_path: 'scenes/session_created.tscn',
    node_path: 'root',
    script_path: 'scripts/harness_game.gd',
  });
  if (attached.error) {
    throw new Error(`Harness-owned game script attachment failed: ${JSON.stringify(attached)}`);
  }

  const launched = await request('godot.runtime.change_scene', {
    scene_path: 'res://scenes/session_created.tscn',
  });
  if (launched.error) throw new Error(`Harness-owned game launch failed: ${JSON.stringify(launched)}`);
  await request('godot.runtime.wait', { frames: 2, frame_type: 'render' });
  const firstTree = await request('godot.runtime.get_scene_tree', {});
  if (firstTree.error || !JSON.stringify(firstTree.result).includes('RuntimeProof')) {
    throw new Error(`Real game did not execute in harness-owned loop: ${JSON.stringify(firstTree)}`);
  }

  const editedWhileRunning = await request('godot.runtime.authoring_add_node', {
    scene_path: 'scenes/session_created.tscn',
    parent_node_path: 'root',
    node_type: 'Node2D',
    node_name: 'AfterObservation',
  });
  if (editedWhileRunning.error) {
    throw new Error(`Post-observation edit failed: ${JSON.stringify(editedWhileRunning)}`);
  }
  const reloaded = await request('godot.runtime.change_scene', {
    scene_path: 'res://scenes/session_created.tscn',
  });
  if (reloaded.error) throw new Error(`Harness-owned game reload failed: ${JSON.stringify(reloaded)}`);
  await request('godot.runtime.wait', { frames: 2, frame_type: 'render' });
  const reloadedTree = await request('godot.runtime.get_scene_tree', {});
  const reloadedJson = JSON.stringify(reloadedTree.result);
  if (reloadedTree.error || !reloadedJson.includes('RuntimeProof')
    || !reloadedJson.includes('AfterObservation')) {
    throw new Error(`Edited real game did not reload in place: ${JSON.stringify(reloadedTree)}`);
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

  await request('godot.runtime.time_scale', { action: 'set', time_scale: 1 });

  socket.end();
}
