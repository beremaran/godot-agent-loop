import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(process.argv[2] ?? join(repositoryRoot, 'assets/previews/assetlib-editor-overview.png'));
const dockOutputPath = join(dirname(outputPath), 'assetlib-editor-dock.png');
const godot = process.env.GODOT_BIN || (process.env.GODOT_PATH ? join(process.env.GODOT_PATH, 'godot.x11.opt.tools.64') : 'godot4');

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate preview bridge port');
  await new Promise(resolvePromise => server.close(resolvePromise));
  return address.port;
}

async function waitForBridge(port, secret) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const socket = createConnection({ host: '127.0.0.1', port });
      await new Promise((resolvePromise, reject) => {
        socket.once('connect', resolvePromise);
        socket.once('error', reject);
      });
      const messages = [
        { id: 1, secret, command: 'handshake', params: { protocol_version: '1', server_version: '1.1.3' } },
        { id: 2, secret, command: 'activity', params: { event: 'request_finished', command: 'create_scene', target: 'res://main.tscn', outcome: 'success', duration_ms: 184, correlation_id: 'preview-create' } },
        { id: 3, secret, command: 'activity', params: { event: 'request_finished', command: 'run_project', target: 'game', outcome: 'success', duration_ms: 932, correlation_id: 'preview-run' } },
        { id: 4, secret, command: 'activity', params: { event: 'request_finished', command: 'game_capture_screenshot', target: '/root/Main', outcome: 'success', duration_ms: 67, correlation_id: 'preview-verify' } },
      ];
      socket.write(messages.map(message => JSON.stringify(message)).join('\n') + '\n');
      return socket;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
    }
  }
}

async function findEditorWindow(projectName) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const { stdout } = await execFileAsync('xwininfo', ['-root', '-tree']);
    const line = stdout.split('\n').find(candidate => candidate.includes(projectName) && candidate.includes('Godot'));
    const match = line?.match(/^\s*(0x[0-9a-f]+)/i);
    if (match) return match[1];
    if (Date.now() >= deadline) throw new Error(`Could not find the ${projectName} editor window`);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  }
}

if (!process.env.DISPLAY) throw new Error('DISPLAY is required to capture the headed addon preview');
const root = mkdtempSync(join(tmpdir(), 'godot-agent-loop-preview-'));
const projectName = `Godot Agent Loop Preview ${process.pid}`;
const addon = join(root, 'addons/godot_agent_loop');
mkdirSync(addon, { recursive: true });
for (const file of ['plugin.gd', 'plugin.cfg', 'README.md', 'LICENSE']) {
  copyFileSync(join(repositoryRoot, 'addons/godot_agent_loop', file), join(addon, file));
}
writeFileSync(join(root, 'project.godot'), [
  'config_version=5',
  '',
  '[application]',
  '',
  `config/name=${JSON.stringify(projectName)}`,
  'config/features=PackedStringArray("4.7")',
  '',
  '[editor_plugins]',
  '',
  'enabled=PackedStringArray("godot_agent_loop")',
  '',
].join('\n'));

const port = await freePort();
const secret = randomUUID();
const child = execFile(godot, ['--editor', '--path', root], {
  env: {
    ...process.env,
    GODOT_MCP_EDITOR_PORT: String(port),
    GODOT_MCP_EDITOR_SECRET: secret,
    GODOT_MCP_EDITOR_START_PAUSED: 'true',
    XDG_DATA_HOME: join(root, 'user-data/data'),
    XDG_CONFIG_HOME: join(root, 'user-data/config'),
    XDG_CACHE_HOME: join(root, 'user-data/cache'),
  },
});
let bridgeSocket;

try {
  bridgeSocket = await waitForBridge(port, secret);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1_500));
  const windowId = await findEditorWindow(projectName);
  mkdirSync(dirname(outputPath), { recursive: true });
  await execFileAsync('import', ['-window', windowId, outputPath]);
  const { stdout: dimensions } = await execFileAsync('identify', ['-format', '%w %h', outputPath]);
  const [width, height] = dimensions.trim().split(/\s+/).map(Number);
  const cropWidth = Math.min(900, width);
  const cropHeight = Math.min(1050, height);
  await execFileAsync('convert', [
    outputPath,
    '-crop', `${cropWidth}x${cropHeight}+${width - cropWidth}+${height - cropHeight}`,
    '+repage',
    dockOutputPath,
  ]);
  console.log(`${outputPath}\n${dockOutputPath}`);
} finally {
  bridgeSocket?.destroy();
  child.kill('SIGTERM');
  await new Promise(resolvePromise => child.once('close', resolvePromise));
  rmSync(root, { recursive: true, force: true });
}
