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
  const root = mkdtempSync(join(tmpdir(), 'godot-agent-loop-e2e-'));
  const projectPath = join(root, options.name ?? 'project');
  mkdirSync(projectPath, { recursive: true });
  const renderer = process.env.GODOT_MCP_E2E_RENDERER;
  writeFileSync(join(projectPath, 'project.godot'), [
    'config_version=5',
    '',
    '[application]',
    '',
    'config/name="godot-agent-loop-e2e-fixture"',
    'run/main_scene="res://main.tscn"',
    'config/features=PackedStringArray("4.4")',
    '',
    ...(renderer ? [
      '[rendering]',
      '',
      `renderer/rendering_method=${JSON.stringify(renderer)}`,
      `renderer/rendering_method.mobile=${JSON.stringify(renderer)}`,
      '',
    ] : []),
  ].join('\n'));
  // The root script provides unprivileged observation hooks: a signal handler
  // that tags nodes with a group (readable via game_get_nodes_in_group) and a
  // startup print (readable via game_get_logs / get_debug_output).
  writeFileSync(join(projectPath, 'main.gd'), [
    'extends Node2D',
    '',
    'signal e2e_event(value: int)',
    '',
    '',
    'func _ready() -> void:',
    '\tprint("e2e-fixture-ready")',
    '',
    '',
    'func observe_child(node: Node) -> void:',
    '\tnode.add_to_group("observed-by-signal")',
    '',
    '',
    'func observe_value(value: int, suffix: String = "") -> void:',
    '\tadd_to_group("signal-value-%s%s" % [value, suffix])',
    '',
    '',
    'func emit_e2e_event(value: int) -> void:',
    '\te2e_event.emit(value)',
    '',
    '',
    'func free_anchor() -> void:',
    '\tget_node("Anchor").queue_free()',
    '',
    '',
    'func _input(event: InputEvent) -> void:',
    '\tif event is InputEventMouseButton:',
    '\t\tvar button := event as InputEventMouseButton',
    '\t\tvar state := "pressed" if button.pressed else "released"',
    '\t\tadd_to_group("mouse-button-%s-%s-%s-%s" % [button.button_index, state, roundi(button.position.x), roundi(button.position.y)])',
    '\t\tadd_to_group("mouse-wheel-%s-%s-factor-%s" % [button.button_index, state, button.factor])',
    '\telif event is InputEventMouseMotion:',
    '\t\tvar motion := event as InputEventMouseMotion',
    '\t\tadd_to_group("mouse-motion-%s-%s-mask-%s" % [roundi(motion.position.x), roundi(motion.position.y), motion.button_mask])',
    '\t\tadd_to_group("mouse-relative-%s-%s" % [roundi(motion.relative.x), roundi(motion.relative.y)])',
    '\telif event is InputEventKey:',
    '\t\tvar key := event as InputEventKey',
    '\t\tvar state := "pressed" if key.pressed else "released"',
    '\t\tadd_to_group("key-%s-%s" % [OS.get_keycode_string(key.keycode), state])',
    '\t\tadd_to_group("key-detail-%s-physical-%s-%s-shift-%s-ctrl-%s-alt-%s-meta-%s-unicode-%s" % [OS.get_keycode_string(key.keycode), OS.get_keycode_string(key.physical_keycode), state, key.shift_pressed, key.ctrl_pressed, key.alt_pressed, key.meta_pressed, key.unicode])',
    '\t\tadd_to_group("key-unicode-%s-%s-alt-%s" % [key.unicode, state, key.alt_pressed])',
    '\telif event is InputEventJoypadButton:',
    '\t\tvar button := event as InputEventJoypadButton',
    '\t\tadd_to_group("joy-button-%s-%s-%s-pressure-%s" % [button.device, button.button_index, button.pressed, button.pressure])',
    '\telif event is InputEventJoypadMotion:',
    '\t\tvar motion := event as InputEventJoypadMotion',
    '\t\tadd_to_group("joy-axis-%s-%s-value-%s" % [motion.device, motion.axis, motion.axis_value])',
    '\telif event is InputEventScreenTouch:',
    '\t\tvar touch := event as InputEventScreenTouch',
    '\t\tadd_to_group("touch-%s-%s-%s-%s" % [touch.index, touch.pressed, roundi(touch.position.x), roundi(touch.position.y)])',
    '\telif event is InputEventScreenDrag:',
    '\t\tvar drag := event as InputEventScreenDrag',
    '\t\tadd_to_group("touch-drag-%s-%s-%s" % [drag.index, roundi(drag.position.x), roundi(drag.position.y)])',
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
    '[node name="DeterministicBackground" type="ColorRect" parent="."]',
    'offset_right = 1152.0',
    'offset_bottom = 648.0',
    'mouse_filter = 2',
    'color = Color(0.2, 0.4, 0.6, 1)',
    '',
    '[node name="Anchor" type="Node2D" parent="."]',
    '',
    '[node name="Tiles" type="TileMapLayer" parent="."]',
    '',
    '[node name="Line" type="Line2D" parent="."]',
    '',
    '[node name="Polygon" type="Polygon2D" parent="."]',
    '',
    '[node name="VisualTarget" type="MeshInstance3D" parent="."]',
    '',
    '[node name="Physics2D" type="Node2D" parent="."]',
    '',
    '[node name="Wall" type="StaticBody2D" parent="Physics2D"]',
    'position = Vector2(50, 0)',
    '',
    '[node name="Crate" type="RigidBody2D" parent="Physics2D"]',
    'position = Vector2(50, 0)',
    'gravity_scale = 0.0',
    '',
    '[node name="Sensor" type="Area2D" parent="Physics2D"]',
    'position = Vector2(50, 0)',
    '',
    '[node name="Physics3D" type="Node3D" parent="."]',
    '',
    '[node name="Wall" type="StaticBody3D" parent="Physics3D"]',
    '',
    '[node name="Crate" type="RigidBody3D" parent="Physics3D"]',
    'position = Vector3(0, 0, 5)',
    'gravity_scale = 0.0',
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
 * A 0.6s 16x16 Theora video (generated once with ffmpeg, embedded so CI needs no
 * codec tooling). Godot imports .ogv into a VideoStreamTheora resource.
 */
const TINY_OGV_BASE64 = [
  'T2dnUwACAAAAAAAAAAAFeRHZAAAAAM87ypsBKoB0aGVvcmEDAgEAAQABAAAQAAAQAAAAAAAFAAAAAQAAAQAAAQAAAAAAwE9nZ1MA',
  'AAAAAAAAAAAABXkR2QEAAAD6QUBrDj////////////////+QgXRoZW9yYQ0AAABMYXZmNjAuMTYuMTAwAQAAAB8AAABlbmNvZGVy',
  'PUxhdmM2MC4zMS4xMDIgbGlidGhlb3JhgnRoZW9yYb7NKPe5zWsYtalJShBznOYxjFKUpCEIMYxiEIQhCEAAAAAAAAAAAAARba5T',
  'Z5LI/FYS/Hg5W2zmKvVoq1QoEykkWhD+eTmbjWZTCXiyVSmTiSSCGQh8PB2OBqNBgLxWKhQJBGIhCHw8HAyGAsFAiDgVFtrlNnks',
  'j8VhL8eDlbbOYq9WirVCgTKSRaEP55OZuNZlMJeLJVKZOJJIIZCHw8HY4Go0GAvFYqFAkEYiEIfDwcDIYCwUCIOBQLDw8PDw8PDw',
  '8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw8MDA8SFBQVDQ0OERIVFRQODg',
  '8SFBUVFQ4QERMUFRUVEBEUFRUVFRUSExQVFRUVFRQVFRUVFRUVFRUVFRUVFRUQDAsQFBkbHA0NDhIVHBwbDg0QFBkcHBwOEBMWGx',
  '0dHBETGRwcHh4dFBgbHB0eHh0bHB0dHh4eHh0dHR0eHh4dEAsKEBgoMz0MDA4TGjo8Nw4NEBgoOUU4DhEWHTNXUD4SFiU6RG1nTR',
  'gjN0BRaHFcMUBOV2d5eGVIXF9icGRnYxMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEx',
  'MTExMTExMTExMTExMSEhUZGhoaGhIUFhoaGhoaFRYZGhoaGhoZGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGh',
  'oaERIWHyQkJCQSFBgiJCQkJBYYISQkJCQkHyIkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJBESGC9jY2NjEh',
  'UaQmNjY2MYGjhjY2NjYy9CY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2MVFRUVFRUVFRUVFRUVFRUVFRUVFR',
  'UVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVEhISFRcYGRsSEhUXGBkbHBIVFxgZGxwdFRcYGRscHR',
  '0XGBkbHB0dHRgZGxwdHR0eGRscHR0dHh4bHB0dHR4eHhERERQXGhwgEREUFxocICIRFBcaHCAiJRQXGhwgIiUlFxocICIlJSUaHC',
  'AiJSUlKRwgIiUlJSkqICIlJSUpKioQEBAUGBwgKBAQFBgcICgwEBQYHCAoMEAUGBwgKDBAQBgcICgwQEBAHCAoMEBAQGAgKDBAQE',
  'BggCgwQEBAYICAB8Xlx0fV7c7D8vrrAaZid8hRvB1RN7csxFuo43wH7lEkS9wbGS+tVSNMyuxdiECcjB7R1Ml85htasNjKpSvPt3',
  'D8k7iGmZXYuxBC+RR4arUGxkvH5y7mJXR7R5Jwn3VUhBiuap91VIrsaCM5TSg9o867khwMrWY2+cP4rwvBLzt/wnHaYe0edSRMYC',
  '6tZmU1BrvhktIUf2gXoU8bHMuyNA7lB7R51ym213sFcFKowIviT/i0Wscg+4RDubX+4haRsMxZWgN05K5FD3bzqS9VSVCPM4TpWs',
  '2C43ihFdgaSByeKHu3Xf/2TG8tgpB7PAtOs7jixWYw+Ayo5GjUTSybX/1KW52RxYfB8nBNLJtHgt4DPq6BZWBFpjyZX/1KW5Ca0e',
  'vOwG1EX/A9j5fQm5hOz6W2CtcCaWTXTFAeZO71VIgCTX69y9TiaXag3Os2ES1DcLKw0/xR5HfnCqkpQF0Z1kxKNfhZWLycml2ked',
  'uHMQh3HubB/pbUUoCK5wxetZRZWPJF/bdyE21H2YjMOhP/pkthqKUCOEWVm68+1J5n7ahES5sOhaZPdOC5j4kc91FVIsrF8ofe+A',
  '2on/16Z4RiKQZcMU3NouO9N4YAvrWaiA6h4bfLqhTitbnnJ2iPSVRNJH+aZGE+YXzq7Ah/OncW2K59AKamlocOUYTSvaJPNcjDfM',
  'GrmG9pOV2MbgI9v3B3ECZ7RLJ51UpzMn0C1huA87Ngom9lkiaw3t5yvFZmDl1HpkuP+PiqlawgD69jAT5Nxr2i6cwiytcwHhK2KJ',
  'vZI9C1m/4VUil8RvO/ydxmgsFdzdgGpMbUeyyRNOi1k5hMb6hVSMuTrOE/xuDhGExQ219l07sV2kG5fOEnkWHwgqUkbvC0P2KTyt',
  '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',
].join('');

/** Write the Theora fixture; run importProjectResources() before the engine loads it. */
export function writeOgvFixture(projectPath: string, relativePath: string): void {
  writeFileSync(join(projectPath, relativePath), Buffer.from(TINY_OGV_BASE64, 'base64'));
}

/**
 * Run Godot's import step over a project so binary assets (PNG textures) are
 * loadable before the MCP server starts. Product-level import behavior is
 * covered separately through manage_import_pipeline.
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
  /** OS pid of the spawned MCP server process, for crash-injection tests. */
  pid: number;
  /** Live redacted stderr lines emitted by the MCP server process. */
  serverLogs: string[];
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
  /** Existing exhaustive suites request full discovery; product default is core. */
  toolSurface?: 'core' | 'full';
  /** Acceptance tests may inspect uninstall residue after MCP teardown. */
  preserveProject?: boolean;
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
      ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
      ...(process.env.WAYLAND_DISPLAY ? { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY } : {}),
      ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
      ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
      GODOT_PATH: godotBinary,
      GODOT_MCP_RUNTIME_PORT: String(runtimePort),
      GODOT_MCP_ALLOWED_DIRS: project.root,
      GODOT_MCP_TOOL_SURFACE: options.toolSurface ?? 'full',
      // Isolate user:// so parallel/leftover state cannot bleed between tests.
      XDG_DATA_HOME: join(userDataDir, 'data'),
      XDG_CONFIG_HOME: join(userDataDir, 'config'),
      XDG_CACHE_HOME: join(userDataDir, 'cache'),
      ...(options.allowPrivileged ? { GODOT_MCP_ALLOW_PRIVILEGED_COMMANDS: 'true' } : {}),
      ...(options.extraEnv ?? {}),
    },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'godot-agent-loop-e2e', version: '0.0.0' });
  await client.connect(transport);
  const serverLogs: string[] = [];
  transport.stderr?.on('data', (data: Buffer) => {
    serverLogs.push(...data.toString().split('\n').filter(Boolean));
  });

  const call: E2EServer['call'] = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const content = (result.content ?? []) as { type: string; text?: string }[];
    const text = content.filter(item => item.type === 'text').map(item => item.text ?? '').join('\n');
    return { text, isError: result.isError === true, raw: result };
  };

  const waitForGameConnection: E2EServer['waitForGameConnection'] = async () => {
    const deadline = Date.now() + 100_000;
    for (;;) {
      const result = await call('game_get_scene_tree');
      if (!result.isError) return;
      if (!/Not connected|No active Godot process/i.test(result.text)) {
        throw new Error(`Unexpected error while waiting for the game connection: ${result.text}`);
      }
      if (Date.now() > deadline) {
        const debug = await call('get_debug_output');
        const diagnostics = serverLogs.slice(-40).join('\n');
        throw new Error([
          `Game connection never became ready: ${result.text}`,
          debug.text ? `Godot debug output:\n${debug.text}` : '',
          diagnostics ? `MCP diagnostics:\n${diagnostics}` : '',
        ].filter(Boolean).join('\n'));
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  };

  const close: E2EServer['close'] = async () => {
    try {
      await client.close();
    } finally {
      await assertNoLeakedGodotProcesses(project.root);
      if (!options.preserveProject) rmSync(project.root, { recursive: true, force: true });
    }
  };

  const pid = transport.pid;
  if (pid === null) throw new Error('MCP server transport has no pid after connect');

  return {
    client, runtimePort, root: project.root, projectPath: project.projectPath,
    pid, serverLogs, call, waitForGameConnection, close,
  };
}

/**
 * Force-kill every Godot process referencing the given root. Crash-injection
 * tests use this to reap the game a SIGKILLed MCP server orphaned, standing in
 * for the user cleaning up after a crash.
 */
export async function killGodotProcesses(rootDir: string): Promise<void> {
  await killMatchingProcesses(rootDir);
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
  await killMatchingProcesses(rootDir);
  throw new Error(`Leaked Godot processes for ${rootDir}:\n${survivors.join('\n')}`);
}

async function findProcesses(needle: string): Promise<string[]> {
  if (process.platform === 'win32') {
    try {
      const script = [
        '$needle = $env:GODOT_MCP_PROCESS_NEEDLE',
        'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) } |',
        'ForEach-Object { "{0} {1}" -f $_.ProcessId, $_.CommandLine }',
      ].join('; ');
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, GODOT_MCP_PROCESS_NEEDLE: needle },
      });
      return stdout.split(/\r?\n/).filter(line => line.trim() !== '');
    } catch {
      return [];
    }
  }
  try {
    const { stdout } = await execFileAsync('pgrep', ['-af', needle]);
    return stdout.split('\n').filter(line => line.trim() !== '');
  } catch {
    // pgrep exits 1 when nothing matches.
    return [];
  }
}

async function killMatchingProcesses(needle: string): Promise<void> {
  if (process.platform === 'win32') {
    const script = [
      '$needle = $env:GODOT_MCP_PROCESS_NEEDLE',
      'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) } |',
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    ].join('; ');
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, GODOT_MCP_PROCESS_NEEDLE: needle },
    }).catch(() => undefined);
    return;
  }
  await execFileAsync('pkill', ['-9', '-f', needle]).catch(() => undefined);
}
