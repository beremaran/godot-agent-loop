import { execFile } from 'node:child_process';
import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const execFileAsync = promisify(execFile);

/**
 * Full-path E2E harness: spawns the built build/index.js server over stdio,
 * drives it with the official MCP SDK client, and gives every test an
 * isolated temporary project, runtime port, and user-data directory with
 * deterministic teardown.
 */

export const repoRoot = join(new URL('../../..', import.meta.url).pathname);

/** Resolve the Godot binary the same way tests/godot/godot-bin.sh does. */
export function resolveGodotBinary(): string {
  const fromEnv = process.env.GODOT_BIN;
  if (fromEnv) return fromEnv;
  for (const name of ['godot4', 'godot']) {
    for (const dir of (process.env.PATH ?? '').split(':')) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not here; keep looking.
      }
    }
  }
  const godotDir = process.env.GODOT_PATH;
  if (godotDir) {
    try {
      for (const file of readdirSync(godotDir)) {
        if (!file.startsWith('godot')) continue;
        const candidate = join(godotDir, file);
        try {
          accessSync(candidate, constants.X_OK);
          return candidate;
        } catch {
          // Not executable; keep looking.
        }
      }
    } catch {
      // GODOT_PATH may be a file path rather than a directory.
      return godotDir;
    }
  }
  throw new Error('No Godot binary found; set GODOT_BIN or GODOT_PATH');
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not allocate a port'));
        return;
      }
      server.close(() => { resolve(address.port); });
    });
    server.on('error', reject);
  });
}

export interface TempProjectOptions {
  /** Directory name; include spaces or non-ASCII to exercise exotic paths. */
  name?: string;
}

/** A minimal runnable Godot project in a throwaway directory. */
export function createTempProject(options: TempProjectOptions = {}): { root: string; projectPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'godot-mcp-e2e-'));
  const projectPath = join(root, options.name ?? 'project');
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(join(projectPath, 'project.godot'), [
    'config_version=5',
    '',
    '[application]',
    '',
    'config/name="godot-mcp-e2e-fixture"',
    'run/main_scene="res://main.tscn"',
    'config/features=PackedStringArray("4.4")',
    '',
  ].join('\n'));
  // The root script provides unprivileged observation hooks: a signal handler
  // that tags nodes with a group (readable via game_get_nodes_in_group) and a
  // startup print (readable via game_get_logs / get_debug_output).
  writeFileSync(join(projectPath, 'main.gd'), [
    'extends Node2D',
    '',
    '',
    'func _ready() -> void:',
    '\tprint("e2e-fixture-ready")',
    '',
    '',
    'func observe_child(node: Node) -> void:',
    '\tnode.add_to_group("observed-by-signal")',
    '',
  ].join('\n'));
  writeFileSync(join(projectPath, 'main.tscn'), [
    '[gd_scene load_steps=2 format=3]',
    '',
    '[ext_resource type="Script" path="res://main.gd" id="1"]',
    '',
    '[node name="Main" type="Node2D"]',
    'script = ExtResource("1")',
    '',
    '[node name="Anchor" type="Node2D" parent="."]',
    '',
  ].join('\n'));
  return { root, projectPath };
}

/** A 1x1 PNG for texture fixtures; written rather than committed to keep fixtures text-only. */
export function writePngFixture(projectPath: string, relativePath: string): void {
  writeFileSync(
    join(projectPath, relativePath),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  );
}

/**
 * Run Godot's import step over a project so binary assets (PNG textures) are
 * loadable by later engine invocations. Test fixture preparation only — the
 * MCP surface has no import tool yet (a tracked P1 capability gap).
 */
export async function importProjectResources(projectPath: string): Promise<void> {
  await execFileAsync(resolveGodotBinary(), ['--headless', '--path', projectPath, '--import'], { timeout: 60_000 })
    .catch(() => undefined); // --import exits non-zero on some versions even after importing.
}

export interface E2EServer {
  client: Client;
  runtimePort: number;
  root: string;
  projectPath: string;
  /** Tool-call helper that returns the text payload and error flag. */
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean; raw: unknown }>;
  /** Poll a runtime-backed tool until the game connection is live. */
  waitForGameConnection(): Promise<void>;
  close(): Promise<void>;
}

export interface StartServerOptions {
  allowPrivileged?: boolean;
  project?: { root: string; projectPath: string };
  extraEnv?: Record<string, string>;
}

export async function startServer(options: StartServerOptions = {}): Promise<E2EServer> {
  const project = options.project ?? createTempProject();
  const runtimePort = await freePort();
  const godotBinary = resolveGodotBinary();
  const userDataDir = join(project.root, 'user-data');
  mkdirSync(userDataDir, { recursive: true });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repoRoot, 'build/index.js')],
    env: {
      ...getDefaultEnvironment(),
      GODOT_PATH: godotBinary,
      GODOT_MCP_RUNTIME_PORT: String(runtimePort),
      GODOT_MCP_ALLOWED_DIRS: project.root,
      GODOT_MCP_RUN_HEADLESS: 'true',
      // Isolate user:// so parallel/leftover state cannot bleed between tests.
      XDG_DATA_HOME: join(userDataDir, 'data'),
      XDG_CONFIG_HOME: join(userDataDir, 'config'),
      XDG_CACHE_HOME: join(userDataDir, 'cache'),
      ...(options.allowPrivileged ? { GODOT_MCP_ALLOW_PRIVILEGED_COMMANDS: 'true' } : {}),
      ...(options.extraEnv ?? {}),
    },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'godot-mcp-e2e', version: '0.0.0' });
  await client.connect(transport);

  const call: E2EServer['call'] = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const content = (result.content ?? []) as { type: string; text?: string }[];
    const text = content.filter(item => item.type === 'text').map(item => item.text ?? '').join('\n');
    return { text, isError: result.isError === true, raw: result };
  };

  const waitForGameConnection: E2EServer['waitForGameConnection'] = async () => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const result = await call('game_get_scene_tree');
      if (!result.isError) return;
      if (!/Not connected|No active Godot process/i.test(result.text)) {
        throw new Error(`Unexpected error while waiting for the game connection: ${result.text}`);
      }
      if (Date.now() > deadline) throw new Error(`Game connection never became ready: ${result.text}`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  };

  const close: E2EServer['close'] = async () => {
    try {
      await client.close();
    } finally {
      await assertNoLeakedGodotProcesses(project.root);
      rmSync(project.root, { recursive: true, force: true });
    }
  };

  return { client, runtimePort, root: project.root, projectPath: project.projectPath, call, waitForGameConnection, close };
}

/**
 * Independent observation that teardown owned its processes: no Godot process
 * referencing the temporary project may survive the server. Waits briefly for
 * SIGTERM delivery, then fails loudly (after SIGKILLing strays so one failure
 * cannot cascade into later tests).
 */
export async function assertNoLeakedGodotProcesses(rootDir: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let survivors = await findProcesses(rootDir);
  while (survivors.length > 0 && Date.now() <= deadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
    survivors = await findProcesses(rootDir);
  }
  if (survivors.length === 0) return;
  await execFileAsync('pkill', ['-9', '-f', rootDir]).catch(() => undefined);
  throw new Error(`Leaked Godot processes for ${rootDir}:\n${survivors.join('\n')}`);
}

async function findProcesses(needle: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-af', needle]);
    return stdout.split('\n').filter(line => line.trim() !== '');
  } catch {
    // pgrep exits 1 when nothing matches.
    return [];
  }
}
