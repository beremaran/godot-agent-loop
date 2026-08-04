import { createErrorResponse, errorMessage, normalizeParameters, type ToolArguments } from '../utils.js';
import type { GameCommandService } from '../game-command-service.js';
import { VisualRegressionService } from './visual-regression-service.js';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBoundedObservationResponse } from '../observation-result.js';

export interface GameToolHandlerContext {
  commands: GameCommandService;
}

interface GameCommandApi {
  getActiveProcess: () => boolean;
  readNewErrors: (limit?: number) => { items: string[]; remaining: number; byteLimited: boolean };
  readNewLogs: (limit?: number) => { items: string[]; remaining: number; byteLimited: boolean };
  gameCommand: GameCommandService['execute'];
}


/** Implements the tools that operate on a running Godot game. */
export class GameToolHandlers {
  private readonly context: GameToolHandlerContext & GameCommandApi;
  private readonly visualRegression: VisualRegressionService;

  constructor(context: GameToolHandlerContext) {
    // Keep the per-tool mapping functions local to this handler while the
    // runtime checks, transport, and response handling live in the service.
    this.context = {
      ...context,
      getActiveProcess: () => context.commands.hasActiveProcess(),
      readNewErrors: limit => context.commands.readNewErrors(limit),
      readNewLogs: limit => context.commands.readNewLogs(limit),
      gameCommand: context.commands.execute.bind(context.commands),
    };
    this.visualRegression = new VisualRegressionService(context.commands);
  }

  public async handleGameScreenshot(args: ToolArguments = {}) {
    if (!this.context.commands.hasActiveProcess()) {
      return createErrorResponse('No active Godot process. Use run_project first.');
    }
    if (!this.context.commands.isConnected()) {
      return createErrorResponse('Not connected to game interaction server. Wait a moment and try again.');
    }

    try {
      const response = await this.context.commands.send('screenshot');
      if ('error' in response) {
        return createErrorResponse(`Screenshot failed: ${response.error.message}`);
      }
      const result = response.result as { data?: string; width?: number; height?: number };
      const bytes = Buffer.from(result.data ?? '', 'base64');
      const digest = createHash('sha256').update(bytes).digest('hex');
      let artifactPath: string | null = null;
      if (args.retainArtifact === true && bytes.length > 0) {
        const artifactDirectory = join(tmpdir(), 'godot-agent-loop-artifacts');
        mkdirSync(artifactDirectory, { recursive: true });
        artifactPath = join(artifactDirectory, `${digest}.png`);
        writeFileSync(artifactPath, bytes);
      }
      return {
        content: [
          {
            type: 'image',
            data: result.data,
            mimeType: 'image/png',
          },
          {
            type: 'text',
            text: JSON.stringify({
              captured: bytes.length > 0, width: result.width, height: result.height,
              bytes: bytes.length, sha256: digest, artifact_path: artifactPath,
              project_artifact: false, visual_regression_metadata: null,
            }, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      return createErrorResponse(`Screenshot failed: ${errorMessage(error)}`);
    }
  }

  public async handleGameVisualRegression(args: ToolArguments) {
    if (args.action !== 'capture_baseline' && args.action !== 'compare') {
      return createErrorResponse('action must be capture_baseline or compare.');
    }
    return this.visualRegression.execute(args);
  }

  public async handleGameClick(args: ToolArguments) {
    return this.context.commands.execute('click', args, a => ({ x: a.x ?? 0, y: a.y ?? 0, button: a.button ?? 1 }));
  }

  public async handleGameKeyPress(args: ToolArguments) {
    args = args || {};
    if (!args.key && !args.action && !args.text) return createErrorResponse('Must provide exactly one of "key", "action", or "text".');
    const params: Record<string, unknown> = {};
    if (args.key) params.key = args.key;
    if (args.action) params.action = args.action;
    if (args.text) params.text = args.text;
    if (args.pressed !== undefined) params.pressed = args.pressed;
    for (const option of ['physical', 'shift', 'ctrl', 'alt', 'meta']) {
      if (args[option] !== undefined) params[option] = args[option];
    }
    return this.context.commands.execute('key_press', args, () => params);
  }

  public async handleGameMouseMove(args: ToolArguments) {
    return this.context.commands.execute('mouse_move', args, a => ({
      x: a.x ?? 0, y: a.y ?? 0, relative_x: a.relative_x ?? 0, relative_y: a.relative_y ?? 0,
    }));
  }

  public async handleGameGetUi(args: ToolArguments) {
    return this.context.gameCommand('get_ui_elements', args, a => ({
      ...(a.rootPath ? { root_path: a.rootPath } : {}),
      max_elements: a.maxElements ?? 200,
    }));
  }

  public async handleGameGetSceneTree(args: ToolArguments) {
    return this.context.gameCommand('get_scene_tree', args, a => ({ max_nodes: a.maxNodes ?? 1000 }));
  }

  public async handleGameEval(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.code) return createErrorResponse('code parameter is required.');
    return this.context.gameCommand('eval', args, a => ({ code: a.code }), 30000);
  }

  public async handleGameGetProperty(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.property) return createErrorResponse('nodePath and property are required.');
    return this.context.gameCommand('get_property', args, a => ({ node_path: a.nodePath, property: a.property }));
  }

  public async handleGameSetProperty(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.property) return createErrorResponse('nodePath and property are required.');
    return this.context.gameCommand('set_property', args, a => ({
      node_path: a.nodePath, property: a.property, value: a.value, type_hint: a.typeHint || '',
    }));
  }

  public async handleGameCallMethod(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.method) return createErrorResponse('nodePath and method are required.');
    return this.context.gameCommand('call_method', args, a => ({
      node_path: a.nodePath, method: a.method, args: a.args || [],
    }));
  }

  public async handleGameGetNodeInfo(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath) return createErrorResponse('nodePath is required.');
    return this.context.gameCommand('get_node_info', args, a => ({
      node_path: a.nodePath,
      detail: a.detail ?? 'full',
      property_names: a.propertyNames ?? [],
    }));
  }

  public async handleGameInstantiateScene(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.scenePath) return createErrorResponse('scenePath is required.');
    return this.context.gameCommand('instantiate_scene', args, a => ({
      scene_path: a.scenePath, parent_path: a.parentPath || '/root',
    }));
  }

  public async handleGameRemoveNode(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath) return createErrorResponse('nodePath is required.');
    return this.context.gameCommand('remove_node', args, a => ({ node_path: a.nodePath }));
  }

  public async handleGameChangeScene(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.scenePath) return createErrorResponse('scenePath is required.');
    return this.context.gameCommand('change_scene', args, a => ({ scene_path: a.scenePath }));
  }

  public async handleGamePerformance(args: ToolArguments = {}) {
    args = normalizeParameters(args || {});
    const action = args.action ?? 'sample';
    if (!['sample', 'start', 'stop', 'report', 'stress', 'leaks'].includes(action)) {
      return createErrorResponse('action must be sample, start, stop, report, stress, or leaks.');
    }
    return this.context.gameCommand('get_performance', args, a => ({
      action: a.action ?? 'sample', sample_count: a.sampleCount ?? a.sample_count ?? 1, sampleCount: a.sampleCount ?? a.sample_count ?? 1,
    }));
  }

  public async handleGameWait(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (args.frames !== undefined && (!Number.isInteger(args.frames) || args.frames < 1)) {
      return createErrorResponse('frames must be a positive integer.');
    }
    return this.context.gameCommand('wait', args, a => ({ frames: a.frames ?? 1, frame_type: a.frameType || 'render' }), 30000);
  }


  public async handleGameConnectSignal(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.signalName || !args.targetPath || !args.method)
      return createErrorResponse('nodePath, signalName, targetPath, and method are required.');
    return this.context.gameCommand('connect_signal', args, a => ({
      node_path: a.nodePath, signal_name: a.signalName, target_path: a.targetPath, method: a.method,
      ...(a.binds ? { binds: a.binds } : {}),
      ...(a.deferred !== undefined ? { deferred: a.deferred } : {}),
      ...(a.oneShot !== undefined ? { one_shot: a.oneShot } : {}),
      ...(a.referenceCounted !== undefined ? { reference_counted: a.referenceCounted } : {}),
    }));
  }

  public async handleGameDisconnectSignal(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.signalName || !args.targetPath || !args.method)
      return createErrorResponse('nodePath, signalName, targetPath, and method are required.');
    return this.context.gameCommand('disconnect_signal', args, a => ({
      node_path: a.nodePath, signal_name: a.signalName, target_path: a.targetPath, method: a.method,
      ...(a.binds ? { binds: a.binds } : {}),
    }));
  }

  public async handleGameEmitSignal(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.signalName) return createErrorResponse('nodePath and signalName are required.');
    return this.context.gameCommand('emit_signal', args, a => ({
      node_path: a.nodePath, signal_name: a.signalName, args: a.args || [],
    }));
  }

  public async handleGameGetNodesInGroup(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.group) return createErrorResponse('group is required.');
    return this.context.gameCommand('get_nodes_in_group', args, a => ({ group: a.group }));
  }

  public async handleGameFindNodesByClass(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.className) return createErrorResponse('className is required.');
    return this.context.gameCommand('find_nodes_by_class', args, a => ({
      class_name: a.className, root_path: a.rootPath || '/root',
    }));
  }

  public async handleGameReparentNode(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.newParentPath) return createErrorResponse('nodePath and newParentPath are required.');
    return this.context.gameCommand('reparent_node', args, a => ({
      node_path: a.nodePath, new_parent_path: a.newParentPath, keep_global_transform: a.keepGlobalTransform !== false,
    }));
  }

  public async handleGameGetErrors(args: ToolArguments) {
    if (!this.context.getActiveProcess())
      return createErrorResponse('No active Godot process. Use run_project first.');
    const { items: errors, remaining, byteLimited } = this.context.readNewErrors(args?.maxItems ?? 1000);
    return createBoundedObservationResponse(
      { count: errors.length, errors, remaining, hasMore: remaining > 0 },
      {
        preferredArrayKeys: ['errors'],
        returnedCount: payload => Array.isArray(payload.errors) ? payload.errors.length : 0,
        sourceTruncated: () => remaining > 0 || byteLimited,
        refinement: 'Call game_get_errors again to continue from the unread-error cursor; lower maxItems for smaller pages.',
        continuation: 'Call game_get_errors again with the same or a smaller maxItems value.',
      },
    );
  }

  public async handleGameGetLogs(args: ToolArguments) {
    if (!this.context.getActiveProcess())
      return createErrorResponse('No active Godot process. Use run_project first.');
    const { items: logs, remaining, byteLimited } = this.context.readNewLogs(args?.maxItems ?? 1000);
    return createBoundedObservationResponse(
      { count: logs.length, logs, remaining, hasMore: remaining > 0 },
      {
        preferredArrayKeys: ['logs'],
        returnedCount: payload => Array.isArray(payload.logs) ? payload.logs.length : 0,
        sourceTruncated: () => remaining > 0 || byteLimited,
        refinement: 'Call game_get_logs again to continue from the unread-log cursor; lower maxItems for smaller pages.',
        continuation: 'Call game_get_logs again with the same or a smaller maxItems value.',
      },
    );
  }

  // --- Enhanced input handlers ---

  public async handleGameKeyHold(args: ToolArguments) {
    args = args || {};
    if (!args.key && !args.action) return createErrorResponse('Must provide either "key" or "action" parameter.');
    const params: Record<string, unknown> = {};
    if (args.key) params.key = args.key;
    if (args.action) params.action = args.action;
    return this.context.gameCommand('key_hold', args, () => params);
  }

  public async handleGameKeyRelease(args: ToolArguments) {
    args = args || {};
    if (!args.key && !args.action) return createErrorResponse('Must provide either "key" or "action" parameter.');
    const params: Record<string, unknown> = {};
    if (args.key) params.key = args.key;
    if (args.action) params.action = args.action;
    return this.context.gameCommand('key_release', args, () => params);
  }

  public async handleGameScroll(args: ToolArguments) {
    return this.context.gameCommand('scroll', args, a => ({
      x: a.x ?? 0, y: a.y ?? 0, direction: a.direction || 'up', amount: a.amount || 1,
    }));
  }

  public async handleGameMouseDrag(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (args.fromX === undefined || args.fromY === undefined || args.toX === undefined || args.toY === undefined)
      return createErrorResponse('fromX, fromY, toX, and toY are required.');
    return this.context.gameCommand('mouse_drag', args, a => ({
      from_x: a.fromX, from_y: a.fromY, to_x: a.toX, to_y: a.toY,
      button: a.button ?? 1, steps: a.steps ?? 10,
    }), 30000);
  }

  public async handleGameGamepad(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.type || args.index === undefined || args.value === undefined)
      return createErrorResponse('type, index, and value are required.');
    return this.context.gameCommand('gamepad', args, a => ({
      type: a.type, index: a.index, value: a.value, device: a.device ?? 0,
      ...(a.deadzone !== undefined ? { deadzone: a.deadzone } : {}),
    }));
  }

  public async handleGameGetCamera() {
    return this.context.gameCommand('get_camera', {}, () => ({}));
  }

  public async handleGameGetAudio() {
    return this.context.gameCommand('get_audio', {}, () => ({}));
  }

  public async handleGameSpawnNode(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.type)
      return createErrorResponse('type is required.');
    return this.context.gameCommand('spawn_node', args, a => ({
      type: a.type, name: a.name || '', parent_path: a.parentPath || '/root',
      ...(a.properties ? { properties: a.properties } : {}),
    }));
  }

  public async handleGameManageGroup(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action)
      return createErrorResponse('action is required.');
    return this.context.gameCommand('manage_group', args, a => ({
      action: a.action,
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.group ? { group: a.group } : {}),
    }));
  }

  public async handleGameTouch(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.context.gameCommand('touch', args, a => ({
      action: a.action, x: a.x ?? 0, y: a.y ?? 0,
      ...(a.index !== undefined ? { index: a.index } : {}),
      ...(a.toX !== undefined ? { to_x: a.toX } : {}),
      ...(a.toY !== undefined ? { to_y: a.toY } : {}),
      ...(a.steps !== undefined ? { steps: a.steps } : {}),
    }), 15000);
  }

  public async handleGameInputState(args: ToolArguments) {
    args = normalizeParameters(args || {});
    return this.context.gameCommand('input_state', args, a => ({
      action: a.action || 'query',
      ...(a.x !== undefined ? { x: a.x } : {}),
      ...(a.y !== undefined ? { y: a.y } : {}),
      ...(a.mouseMode ? { mouse_mode: a.mouseMode } : {}),
      ...(a.keys !== undefined ? { keys: a.keys } : {}),
      ...(a.actions !== undefined ? { actions: a.actions } : {}),
      ...(a.mouseButtons !== undefined ? { mouse_buttons: a.mouseButtons } : {}),
    }));
  }

  public async handleGameInputAction(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.context.gameCommand('input_action', args, a => ({
      action: a.action,
      ...(a.actionName ? { action_name: a.actionName } : {}),
      ...(a.strength !== undefined ? { strength: a.strength } : {}),
      ...(a.key ? { key: a.key } : {}),
    }));
  }

  public async handleGameListSignals(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath) return createErrorResponse('nodePath is required.');
    return this.context.gameCommand('list_signals', args, a => ({ node_path: a.nodePath }));
  }

  public async handleGameAwaitSignal(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.signalName) return createErrorResponse('nodePath and signalName are required.');
    const timeout = (args.timeout ?? 10) * 1000 + 2000;
    return this.context.gameCommand('await_signal', args, a => ({
      node_path: a.nodePath, signal_name: a.signalName, timeout: a.timeout ?? 10,
    }), timeout);
  }

  public async handleGameScript(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    return this.context.gameCommand('script', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.source ? { source: a.source } : {}),
      ...(a.className ? { class_name: a.className } : {}),
    }));
  }

  public async handleGameOsInfo(_args: ToolArguments) {
    return this.context.gameCommand('os_info', {}, () => ({}));
  }
}
