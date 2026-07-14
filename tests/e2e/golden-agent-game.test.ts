// @test-kind: e2e
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';
import { repoRoot, startServer, type E2EServer } from './helpers/harness.js';

let server: E2EServer | null = null;

afterEach(async () => {
  if (server) {
    const active = server;
    server = null;
    await active.close();
  }
});

function gameFiles(projectPath: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.godot') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(relative(projectPath, path).replaceAll('\\', '/'));
    }
  };
  visit(projectPath);
  return files.sort();
}

async function requiredCall(
  active: E2EServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; raw: unknown }> {
  const result = await active.call(name, args);
  expect(result.isError, `${name}: ${result.text}`).toBe(false);
  return result;
}

function uiElements(text: string): {
  name: string;
  path: string;
  position?: { x: number; y: number };
  text?: string;
}[] {
  return (JSON.parse(text) as { elements: {
    name: string;
    path: string;
    position?: { x: number; y: number };
    text?: string;
  }[] }).elements;
}

function imageFrom(raw: unknown): PNG {
  const content = (raw as { content: { type: string; data?: string }[] }).content;
  const image = content.find(item => item.type === 'image');
  expect(image?.data).toBeTruthy();
  return PNG.sync.read(Buffer.from(image?.data ?? '', 'base64'));
}

function pixelAt(png: PNG, x: number, y: number): number[] {
  const offset = (y * png.width + x) * 4;
  return Array.from(png.data.subarray(offset, offset + 4));
}

const GAME_SCRIPT = `extends Node2D

enum State { PLAYING, WIN, LOSE }

const SPEED := 360.0
var state: State = State.PLAYING

@onready var background: ColorRect = $Background
@onready var player: ColorRect = $Player
@onready var goal: ColorRect = $Goal
@onready var state_label: Label = $StateLabel
@onready var position_label: Label = $PositionLabel

func _ready() -> void:
	_apply_state()
	print("golden-game-ready")

func _physics_process(delta: float) -> void:
	if state != State.PLAYING:
		return
	if Input.is_action_just_pressed("lose"):
		state = State.LOSE
		_apply_state()
		return
	if Input.is_action_pressed("move_right"):
		player.position.x += SPEED * delta
		position_label.text = "PLAYER X: %d" % roundi(player.position.x)
	if player.position.distance_to(goal.position) < 28.0:
		state = State.WIN
		_apply_state()

func _apply_state() -> void:
	match state:
		State.PLAYING:
			state_label.text = "PLAYING"
			background.color = Color(0.05, 0.09, 0.15, 1.0)
		State.WIN:
			state_label.text = "WIN"
			background.color = Color(0.03, 0.18, 0.08, 1.0)
			print("WIN")
		State.LOSE:
			state_label.text = "LOSE"
			background.color = Color(0.22, 0.04, 0.05, 1.0)
			print("LOSE")
`;

describe('golden cold-agent game build', () => {
  it('replays the distilled agent build and independently proves authoring, input, state, rendering, and cleanup', async () => {
    const liveRun = JSON.parse(readFileSync(join(repoRoot, 'docs/coverage/golden-agent-run.json'), 'utf8')) as {
      result: { outcome: string; verifiedStates: string[] };
      task: { humanCorrections: number };
      toolSelectionFindings: unknown[];
    };
    expect(liveRun.result).toMatchObject({ outcome: 'success', verifiedStates: ['PLAYING', 'WIN', 'LOSE'] });
    expect(liveRun.task.humanCorrections).toBe(0);
    expect(liveRun.toolSelectionFindings.length).toBeGreaterThan(0);

    const root = mkdtempSync(join(tmpdir(), 'godot-mcp-golden-agent-'));
    const projectPath = join(root, 'game');
    mkdirSync(root, { recursive: true });
    server = await startServer({ project: { root, projectPath }, toolSurface: 'core' });

    const listed = await server.client.listTools();
    expect(listed.tools).toHaveLength(39);
    expect(listed.tools.map(tool => tool.name)).not.toContain('game_key_hold');

    await requiredCall(server, 'create_project', { projectPath, projectName: 'Golden Agent Game' });
    await requiredCall(server, 'create_scene', {
      projectPath, scenePath: 'scenes/main.tscn', rootNodeType: 'Node2D',
    });
    await requiredCall(server, 'create_script', {
      projectPath, scriptPath: 'scripts/main.gd', source: GAME_SCRIPT,
    });

    const nodes = [
      { nodeType: 'ColorRect', nodeName: 'Background', properties: {
        position: { x: 0, y: 0 }, size: { x: 800, y: 600 }, color: { r: 0.05, g: 0.09, b: 0.15, a: 1 },
        mouse_filter: 2,
      } },
      { nodeType: 'ColorRect', nodeName: 'Goal', properties: {
        position: { x: 520, y: 280 }, size: { x: 40, y: 40 }, color: { r: 0.15, g: 0.9, b: 0.25, a: 1 },
      } },
      { nodeType: 'ColorRect', nodeName: 'Hazard', properties: {
        position: { x: 80, y: 460 }, size: { x: 40, y: 40 }, color: { r: 0.95, g: 0.12, b: 0.12, a: 1 },
      } },
      { nodeType: 'ColorRect', nodeName: 'Player', properties: {
        position: { x: 80, y: 280 }, size: { x: 40, y: 40 }, color: { r: 0.15, g: 0.65, b: 1, a: 1 },
      } },
      { nodeType: 'Label', nodeName: 'StateLabel', properties: {
        position: { x: 330, y: 24 }, size: { x: 180, y: 48 }, text: 'PLAYING',
        'theme_override_font_sizes/font_size': 32,
      } },
      { nodeType: 'Label', nodeName: 'PositionLabel', properties: {
        position: { x: 24, y: 24 }, size: { x: 240, y: 32 }, text: 'PLAYER X: 80',
      } },
      { nodeType: 'Label', nodeName: 'Instructions', properties: {
        position: { x: 24, y: 540 }, size: { x: 520, y: 32 }, text: 'Hold move_right to reach the goal. Press lose to lose.',
      } },
    ] as const;
    for (const node of nodes) {
      await requiredCall(server, 'add_node', {
        projectPath, scenePath: 'scenes/main.tscn', ...node,
      });
    }
    await requiredCall(server, 'attach_script', {
      projectPath, scenePath: 'scenes/main.tscn', nodePath: 'root', scriptPath: 'scripts/main.gd',
    });
    await requiredCall(server, 'manage_input_map', {
      projectPath, action: 'add', actionName: 'move_right', key: 'D',
    });
    await requiredCall(server, 'manage_input_map', {
      projectPath, action: 'add', actionName: 'lose', key: 'L',
    });
    await requiredCall(server, 'set_main_scene', { projectPath, scenePath: 'scenes/main.tscn' });

    const source = readFileSync(join(projectPath, 'scripts/main.gd'), 'utf8');
    expect(source).toContain('Input.is_action_pressed("move_right")');
    expect(readFileSync(join(projectPath, 'scenes/main.tscn'), 'utf8')).toContain('StateLabel');
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toContain('move_right');

    const verification = await requiredCall(server, 'verify_project', {
      projectPath,
      scene: 'scenes/main.tscn',
      waitFrames: 3,
      captureScreenshot: true,
      assertions: [
        { kind: 'node_exists', nodePath: '/root/root/Player' },
        { kind: 'node_exists', nodePath: '/root/root/Goal' },
        { kind: 'log_contains', text: 'golden-game-ready' },
      ],
    });
    expect(JSON.parse(verification.text) as Record<string, unknown>).toMatchObject({
      passed: true, started: true, stopped: true, teardown: true,
      screenshot: { captured: true, width: expect.any(Number), height: expect.any(Number) },
    });

    await requiredCall(server, 'run_project', { projectPath });
    await server.waitForGameConnection();
    await requiredCall(server, 'game_wait', { frames: 2, frameType: 'physics' });
    const initialUi = uiElements((await requiredCall(server, 'game_get_ui')).text);
    expect(initialUi.find(element => element.name === 'StateLabel')?.text).toBe('PLAYING');
    const initialX = initialUi.find(element => element.name === 'Player')?.position?.x;
    expect(initialX).toBe(80);

    const search = await requiredCall(server, 'godot_tools', {
      action: 'search', query: 'hold key', domain: 'game',
    });
    expect((JSON.parse(search.text) as { results: { name: string }[] }).results)
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'game_key_hold' })]));
    const described = await requiredCall(server, 'godot_tools', {
      action: 'describe', toolName: 'game_key_hold',
    });
    expect((JSON.parse(described.text) as { definition: { name: string } }).definition.name).toBe('game_key_hold');
    await requiredCall(server, 'godot_tools', {
      action: 'call', toolName: 'game_key_hold', arguments: { action: 'move_right' },
    });
    await requiredCall(server, 'game_wait', { frames: 5, frameType: 'physics' });
    const movedUi = uiElements((await requiredCall(server, 'game_get_ui')).text);
    const movedX = movedUi.find(element => element.name === 'Player')?.position?.x;
    expect(movedX).toBeGreaterThan(initialX ?? 0);

    await requiredCall(server, 'game_wait', { frames: 80, frameType: 'physics' });
    await requiredCall(server, 'game_key_release', { action: 'move_right' });
    const wonUi = uiElements((await requiredCall(server, 'game_get_ui')).text);
    expect(wonUi.find(element => element.name === 'StateLabel')?.text).toBe('WIN');
    const winShot = imageFrom((await requiredCall(server, 'game_screenshot')).raw);
    const winPixel = pixelAt(winShot, 10, 10);
    expect(winPixel[1]).toBeGreaterThan(winPixel[0]);
    expect(winPixel[1]).toBeGreaterThan(winPixel[2]);
    await requiredCall(server, 'stop_project');

    await requiredCall(server, 'run_project', { projectPath });
    await server.waitForGameConnection();
    await requiredCall(server, 'game_key_press', { action: 'lose' });
    await requiredCall(server, 'game_wait', { frames: 2, frameType: 'physics' });
    const lostUi = uiElements((await requiredCall(server, 'game_get_ui')).text);
    expect(lostUi.find(element => element.name === 'StateLabel')?.text).toBe('LOSE');
    const loseShot = imageFrom((await requiredCall(server, 'game_screenshot')).raw);
    const losePixel = pixelAt(loseShot, 10, 10);
    expect(losePixel[0]).toBeGreaterThan(losePixel[1]);
    expect(losePixel[0]).toBeGreaterThan(losePixel[2]);
    await requiredCall(server, 'stop_project');

    expect(gameFiles(projectPath)).toEqual([
      'project.godot',
      'scenes/main.tscn',
      'scripts/main.gd',
    ]);
  }, 120_000);
});
