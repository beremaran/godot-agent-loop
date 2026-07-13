import { createErrorResponse, errorMessage, normalizeParameters, type ToolArguments } from '../utils.js';
import type { GameCommandService } from '../game-command-service.js';

export interface GameToolHandlerContext {
  commands: GameCommandService;
}

interface GameCommandApi {
  getActiveProcess: () => boolean;
  readNewErrors: () => string[];
  readNewLogs: () => string[];
  gameCommand: GameCommandService['execute'];
}

/**
 * ParticleProcessMaterial fields the runtime reads, keyed by the camelCase name
 * the MCP surface uses. `processMaterial` is a free-form object, so its keys are
 * normalized like any other argument; without this translation the multi-word
 * fields arrived as camelCase and the runtime — which looks for snake_case —
 * silently dropped them.
 */
const PARTICLE_MATERIAL_FIELDS: Record<string, string> = {
  direction: 'direction',
  spread: 'spread',
  gravity: 'gravity',
  initialVelocityMin: 'initial_velocity_min',
  initialVelocityMax: 'initial_velocity_max',
  color: 'color',
  scaleMin: 'scale_min',
  scaleMax: 'scale_max',
};

function particleProcessMaterial(source: unknown): Record<string, unknown> {
  if (!source || typeof source !== 'object') return {};
  const input = source as Record<string, unknown>;
  const mapped: Record<string, unknown> = {};
  for (const [camel, snake] of Object.entries(PARTICLE_MATERIAL_FIELDS)) {
    if (input[camel] !== undefined) mapped[snake] = input[camel];
  }
  return mapped;
}

/** Implements the tools that operate on a running Godot game. */
export class GameToolHandlers {
  private readonly context: GameToolHandlerContext & GameCommandApi;

  constructor(context: GameToolHandlerContext) {
    // Keep the per-tool mapping functions local to this handler while the
    // runtime checks, transport, and response handling live in the service.
    this.context = {
      ...context,
      getActiveProcess: () => context.commands.hasActiveProcess(),
      readNewErrors: () => context.commands.readNewErrors(),
      readNewLogs: () => context.commands.readNewLogs(),
      gameCommand: context.commands.execute.bind(context.commands),
    };
  }

  public async handleGameScreenshot() {
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
      return {
        content: [
          {
            type: 'image',
            data: result.data,
            mimeType: 'image/png',
          },
          {
            type: 'text',
            text: `Screenshot captured: ${result.width}x${result.height}`,
          },
        ],
      };
    } catch (error: unknown) {
      return createErrorResponse(`Screenshot failed: ${errorMessage(error)}`);
    }
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

  public async handleGameGetUi() {
    return this.context.gameCommand('get_ui_elements', {}, () => ({}));
  }

  public async handleGameGetSceneTree() {
    return this.context.gameCommand('get_scene_tree', {}, () => ({}));
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
    return this.context.gameCommand('get_node_info', args, a => ({ node_path: a.nodePath }));
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

  public async handleGamePause(args: ToolArguments) {
    return this.context.gameCommand('pause', args, a => ({ paused: a.paused !== undefined ? a.paused : true }));
  }

  public async handleGamePerformance() {
    return this.context.gameCommand('get_performance', {}, () => ({}));
  }

  public async handleGameWait(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (args.frames !== undefined && (!Number.isInteger(args.frames) || args.frames < 1)) {
      return createErrorResponse('frames must be a positive integer.');
    }
    return this.context.gameCommand('wait', args, a => ({ frames: a.frames ?? 1, frame_type: a.frameType || 'render' }), 30000);
  }


  /**
   * Handle the read_scene tool - Read a scene file structure
   */

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

  public async handleGamePlayAnimation(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath) return createErrorResponse('nodePath is required.');
    return this.context.gameCommand('play_animation', args, a => ({
      node_path: a.nodePath, action: a.action || 'play', animation: a.animation || '',
    }));
  }

  public async handleGameTweenProperty(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.property || args.finalValue === undefined)
      return createErrorResponse('nodePath, property, and finalValue are required.');
    return this.context.gameCommand('tween_property', args, a => ({
      node_path: a.nodePath, property: a.property, final_value: a.finalValue,
      duration: a.duration ?? 1.0, trans_type: a.transType ?? 0, ease_type: a.easeType ?? 2,
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

  public async handleGameGetErrors() {
    if (!this.context.getActiveProcess())
      return createErrorResponse('No active Godot process. Use run_project first.');
    const errors = this.context.readNewErrors();
    return { content: [{ type: 'text', text: JSON.stringify({ count: errors.length, errors }, null, 2) }] };
  }

  public async handleGameGetLogs() {
    if (!this.context.getActiveProcess())
      return createErrorResponse('No active Godot process. Use run_project first.');
    const logs = this.context.readNewLogs();
    return { content: [{ type: 'text', text: JSON.stringify({ count: logs.length, logs }, null, 2) }] };
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

  // --- Project management handlers ---

  public async handleGameGetCamera() {
    return this.context.gameCommand('get_camera', {}, () => ({}));
  }

  public async handleGameSetCamera(args: ToolArguments) {
    return this.context.gameCommand('set_camera', args, a => ({
      ...(a.position ? { position: a.position } : {}),
      ...(a.rotation ? { rotation: a.rotation } : {}),
      ...(a.zoom ? { zoom: a.zoom } : {}),
      ...(a.fov !== undefined ? { fov: a.fov } : {}),
    }));
  }

  public async handleGameRaycast(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.from || !args.to)
      return createErrorResponse('from and to are required.');
    return this.context.gameCommand('raycast', args, a => ({
      from: a.from, to: a.to, collision_mask: a.collisionMask ?? 0xFFFFFFFF,
    }));
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

  public async handleGameSetShaderParam(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.paramName)
      return createErrorResponse('nodePath and paramName are required.');
    return this.context.gameCommand('set_shader_param', args, a => ({
      node_path: a.nodePath, param_name: a.paramName, value: a.value,
      ...(a.typeHint ? { type_hint: a.typeHint } : {}),
    }));
  }

  public async handleGameAudioPlay(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath)
      return createErrorResponse('nodePath is required.');
    return this.context.gameCommand('audio_play', args, a => ({
      node_path: a.nodePath, action: a.action || 'play',
      ...(a.stream ? { stream: a.stream } : {}),
      ...(a.volume !== undefined ? { volume: a.volume } : {}),
      ...(a.pitch !== undefined ? { pitch: a.pitch } : {}),
      ...(a.bus ? { bus: a.bus } : {}),
      ...(a.fromPosition !== undefined ? { from_position: a.fromPosition } : {}),
    }));
  }

  public async handleGameAudioBus(args: ToolArguments) {
    return this.context.gameCommand('audio_bus', args, a => ({
      bus_name: a.busName || 'Master',
      ...(a.volume !== undefined ? { volume: a.volume } : {}),
      ...(a.mute !== undefined ? { mute: a.mute } : {}),
      ...(a.solo !== undefined ? { solo: a.solo } : {}),
    }));
  }

  public async handleGameNavigatePath(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.start || !args.end)
      return createErrorResponse('start and end are required.');
    return this.context.gameCommand('navigate_path', args, a => ({
      start: a.start, end: a.end, optimize: a.optimize ?? true,
    }));
  }

  public async handleGameTilemap(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath)
      return createErrorResponse('nodePath is required.');
    if (!args.action)
      return createErrorResponse('action is required.');
    return this.context.gameCommand('tilemap', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.x !== undefined ? { x: a.x } : {}),
      ...(a.y !== undefined ? { y: a.y } : {}),
      ...(a.cells ? {
        cells: (a.cells as Record<string, unknown>[]).map(cell => ({
          x: cell.x,
          y: cell.y,
          ...(cell.sourceId !== undefined ? { source_id: cell.sourceId } : {}),
          ...(cell.atlasX !== undefined ? { atlas_x: cell.atlasX } : {}),
          ...(cell.atlasY !== undefined ? { atlas_y: cell.atlasY } : {}),
          ...(cell.altTile !== undefined ? { alt_tile: cell.altTile } : {}),
        })),
      } : {}),
      ...(a.sourceId !== undefined ? { source_id: a.sourceId } : {}),
    }));
  }

  public async handleGameAddCollision(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.parentPath || !args.shapeType)
      return createErrorResponse('parentPath and shapeType are required.');
    return this.context.gameCommand('add_collision', args, a => ({
      parent_path: a.parentPath, shape_type: a.shapeType,
      ...(a.shapeParams ? { shape_params: a.shapeParams } : {}),
      ...(a.collisionLayer !== undefined ? { collision_layer: a.collisionLayer } : {}),
      ...(a.collisionMask !== undefined ? { collision_mask: a.collisionMask } : {}),
      ...(a.disabled !== undefined ? { disabled: a.disabled } : {}),
    }));
  }

  public async handleGameEnvironment(args: ToolArguments) {
    args = normalizeParameters(args || {});
    const params: Record<string, unknown> = { action: args.action || 'set' };
    // Pass through all environment settings
    const envKeys = [
      'backgroundMode', 'backgroundColor', 'ambientLightColor', 'ambientLightEnergy',
      'fogEnabled', 'fogDensity', 'fogLightColor',
      'glowEnabled', 'glowIntensity', 'glowBloom',
      'tonemapMode', 'ssaoEnabled', 'ssaoRadius', 'ssaoIntensity', 'ssrEnabled',
      'brightness', 'contrast', 'saturation',
    ];
    const snakeMap: Record<string, string> = {
      backgroundMode: 'background_mode', backgroundColor: 'background_color',
      ambientLightColor: 'ambient_light_color', ambientLightEnergy: 'ambient_light_energy',
      fogEnabled: 'fog_enabled', fogDensity: 'fog_density', fogLightColor: 'fog_light_color',
      glowEnabled: 'glow_enabled', glowIntensity: 'glow_intensity', glowBloom: 'glow_bloom',
      tonemapMode: 'tonemap_mode', ssaoEnabled: 'ssao_enabled', ssaoRadius: 'ssao_radius',
      ssaoIntensity: 'ssao_intensity', ssrEnabled: 'ssr_enabled',
      brightness: 'brightness', contrast: 'contrast', saturation: 'saturation',
    };
    for (const key of envKeys) {
      if (args[key] !== undefined) {
        params[snakeMap[key]] = args[key];
      }
    }
    return this.context.gameCommand('environment', { ...args }, () => params);
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

  public async handleGameCreateTimer(args: ToolArguments) {
    return this.context.gameCommand('create_timer', args, a => ({
      parent_path: a.parentPath || '/root',
      wait_time: a.waitTime ?? 1.0,
      one_shot: a.oneShot ?? false,
      autostart: a.autostart ?? false,
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  public async handleGameSetParticles(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath)
      return createErrorResponse('nodePath is required.');
    return this.context.gameCommand('set_particles', args, a => ({
      node_path: a.nodePath,
      ...(a.emitting !== undefined ? { emitting: a.emitting } : {}),
      ...(a.amount !== undefined ? { amount: a.amount } : {}),
      ...(a.lifetime !== undefined ? { lifetime: a.lifetime } : {}),
      ...(a.oneShot !== undefined ? { one_shot: a.oneShot } : {}),
      ...(a.speedScale !== undefined ? { speed_scale: a.speedScale } : {}),
      ...(a.explosiveness !== undefined ? { explosiveness: a.explosiveness } : {}),
      ...(a.randomness !== undefined ? { randomness: a.randomness } : {}),
      ...(a.processMaterial ? { process_material: particleProcessMaterial(a.processMaterial) } : {}),
    }));
  }

  public async handleGameCreateAnimation(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.animationName)
      return createErrorResponse('nodePath and animationName are required.');
    return this.context.gameCommand('create_animation', args, a => ({
      node_path: a.nodePath,
      animation_name: a.animationName,
      length: a.length ?? 1.0,
      loop_mode: a.loopMode ?? 0,
      tracks: a.tracks || [],
      ...(a.library !== undefined ? { library: a.library } : {}),
    }));
  }

  public async handleGameSerializeState(args: ToolArguments) {
    args = normalizeParameters(args || {});
    return this.context.gameCommand('serialize_state', args, a => ({
      node_path: a.nodePath || '/root',
      action: a.action || 'save',
      max_depth: a.maxDepth ?? 5,
      ...(a.data ? { data: a.data } : {}),
    }));
  }

  public async handleGamePhysicsBody(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath)
      return createErrorResponse('nodePath is required.');
    return this.context.gameCommand('physics_body', args, a => ({
      node_path: a.nodePath,
      ...(a.gravityScale !== undefined ? { gravity_scale: a.gravityScale } : {}),
      ...(a.mass !== undefined ? { mass: a.mass } : {}),
      ...(a.linearVelocity ? { linear_velocity: a.linearVelocity } : {}),
      ...(a.angularVelocity !== undefined ? { angular_velocity: a.angularVelocity } : {}),
      ...(a.linearDamp !== undefined ? { linear_damp: a.linearDamp } : {}),
      ...(a.angularDamp !== undefined ? { angular_damp: a.angularDamp } : {}),
      ...(a.friction !== undefined ? { friction: a.friction } : {}),
      ...(a.bounce !== undefined ? { bounce: a.bounce } : {}),
      ...(a.freeze !== undefined ? { freeze: a.freeze } : {}),
      ...(a.sleeping !== undefined ? { sleeping: a.sleeping } : {}),
    }));
  }

  public async handleGameCreateJoint(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.parentPath || !args.jointType)
      return createErrorResponse('parentPath and jointType are required.');
    return this.context.gameCommand('create_joint', args, a => ({
      parent_path: a.parentPath,
      joint_type: a.jointType,
      ...(a.nodeAPath ? { node_a_path: a.nodeAPath } : {}),
      ...(a.nodeBPath ? { node_b_path: a.nodeBPath } : {}),
      ...(a.stiffness !== undefined ? { stiffness: a.stiffness } : {}),
      ...(a.damping !== undefined ? { damping: a.damping } : {}),
      ...(a.length !== undefined ? { length: a.length } : {}),
      ...(a.restLength !== undefined ? { rest_length: a.restLength } : {}),
      ...(a.softness !== undefined ? { softness: a.softness } : {}),
      ...(a.initialOffset !== undefined ? { initial_offset: a.initialOffset } : {}),
    }));
  }

  public async handleGameBonePose(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath)
      return createErrorResponse('nodePath is required.');
    return this.context.gameCommand('bone_pose', args, a => ({
      node_path: a.nodePath,
      action: a.action || 'list',
      ...(a.boneIndex !== undefined ? { bone_index: a.boneIndex } : {}),
      ...(a.boneName ? { bone_name: a.boneName } : {}),
      ...(a.position ? { position: a.position } : {}),
      ...(a.rotation ? { rotation: a.rotation } : {}),
      ...(a.scale ? { scale: a.scale } : {}),
    }));
  }

  public async handleGameUiTheme(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.overrides)
      return createErrorResponse('nodePath and overrides are required.');
    return this.context.gameCommand('ui_theme', args, a => ({
      node_path: a.nodePath,
      overrides: a.overrides,
    }));
  }

  public async handleGameViewport(args: ToolArguments) {
    args = normalizeParameters(args || {});
    return this.context.gameCommand('viewport', args, a => ({
      action: a.action || 'create',
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.width !== undefined ? { width: a.width } : {}),
      ...(a.height !== undefined ? { height: a.height } : {}),
      ...(a.msaa !== undefined ? { msaa: a.msaa } : {}),
      ...(a.transparentBg !== undefined ? { transparent_bg: a.transparentBg } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  public async handleGameDebugDraw(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action)
      return createErrorResponse('action is required.');
    return this.context.gameCommand('debug_draw', args, a => ({
      action: a.action,
      ...(a.from ? { from: a.from } : {}),
      ...(a.to ? { to: a.to } : {}),
      ...(a.center ? { center: a.center } : {}),
      ...(a.radius !== undefined ? { radius: a.radius } : {}),
      ...(a.size ? { size: a.size } : {}),
      ...(a.color ? { color: a.color } : {}),
      ...(a.duration !== undefined ? { duration: a.duration } : {}),
    }));
  }

  // --- Batch 1: Networking + Input + System + Signals + Script ---

  public async handleGameHttpRequest(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.url) return createErrorResponse('url is required.');
    return this.context.gameCommand('http_request', args, a => ({
      url: a.url, method: a.method || 'GET',
      ...(a.headers ? { headers: a.headers } : {}),
      ...(a.body !== undefined ? { body: a.body } : {}),
      ...(a.timeout !== undefined ? { timeout: a.timeout } : {}),
    }), 35000);
  }

  public async handleGameWebsocket(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    if (args.action === 'connect' && !args.url) return createErrorResponse('url is required for connect.');
    if (args.action === 'send' && args.message === undefined) return createErrorResponse('message is required for send.');
    return this.context.gameCommand('websocket', args, a => ({
      action: a.action,
      ...(a.url ? { url: a.url } : {}),
      ...(a.message !== undefined ? { message: a.message } : {}),
      ...(a.timeout !== undefined ? { timeout: a.timeout } : {}),
    }), 15000);
  }

  public async handleGameMultiplayer(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.context.gameCommand('multiplayer', args, a => ({
      action: a.action,
      ...(a.port !== undefined ? { port: a.port } : {}),
      ...(a.address ? { address: a.address } : {}),
      ...(a.maxClients !== undefined ? { max_clients: a.maxClients } : {}),
    }));
  }

  public async handleGameRpc(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action || !args.method) return createErrorResponse('nodePath, action, and method are required.');
    return this.context.gameCommand('rpc', args, a => ({
      node_path: a.nodePath, action: a.action, method: a.method,
      ...(a.args !== undefined ? { args: a.args } : {}),
      ...(a.peerId !== undefined ? { peer_id: a.peerId } : {}),
      ...(a.mode ? { mode: a.mode } : {}),
      ...(a.sync !== undefined ? { sync: a.sync } : {}),
      ...(a.transferMode !== undefined ? { transfer_mode: a.transferMode } : {}),
      ...(a.channel !== undefined ? { channel: a.channel } : {}),
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

  public async handleGameWindow(args: ToolArguments) {
    args = normalizeParameters(args || {});
    return this.context.gameCommand('window', args, a => ({
      action: a.action || 'get',
      ...(a.width !== undefined ? { width: a.width } : {}),
      ...(a.height !== undefined ? { height: a.height } : {}),
      ...(a.fullscreen !== undefined ? { fullscreen: a.fullscreen } : {}),
      ...(a.borderless !== undefined ? { borderless: a.borderless } : {}),
      ...(a.title ? { title: a.title } : {}),
      ...(a.position ? { position: a.position } : {}),
      ...(a.vsync !== undefined ? { vsync: a.vsync } : {}),
    }));
  }

  public async handleGameOsInfo(_args: ToolArguments) {
    return this.context.gameCommand('os_info', {}, () => ({}));
  }

  public async handleGameTimeScale(args: ToolArguments) {
    args = normalizeParameters(args || {});
    return this.context.gameCommand('time_scale', args, a => ({
      action: a.action || 'get',
      ...(a.timeScale !== undefined ? { time_scale: a.timeScale } : {}),
    }));
  }

  public async handleGameProcessMode(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.mode) return createErrorResponse('nodePath and mode are required.');
    return this.context.gameCommand('process_mode', args, a => ({
      node_path: a.nodePath, mode: a.mode,
    }));
  }

  public async handleGameWorldSettings(args: ToolArguments) {
    args = normalizeParameters(args || {});
    return this.context.gameCommand('world_settings', args, a => ({
      action: a.action || 'get',
      ...(a.gravity !== undefined ? { gravity: a.gravity } : {}),
      ...(a.gravityDirection ? { gravity_direction: a.gravityDirection } : {}),
      ...(a.physicsFps !== undefined ? { physics_fps: a.physicsFps } : {}),
    }));
  }

  // --- Batch 2: 3D Rendering + Lighting + Sky + Physics ---

  public async handleGameCsg(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.context.gameCommand('csg', args, a => ({
      action: a.action,
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.csgType ? { csg_type: a.csgType } : {}),
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.operation ? { operation: a.operation } : {}),
      ...(a.size ? { size: a.size } : {}),
      ...(a.radius !== undefined ? { radius: a.radius } : {}),
      ...(a.height !== undefined ? { height: a.height } : {}),
      ...(a.material ? { material: a.material } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  public async handleGameMultimesh(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.context.gameCommand('multimesh', args, a => ({
      action: a.action,
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.meshType ? { mesh_type: a.meshType } : {}),
      ...(a.count !== undefined ? { count: a.count } : {}),
      ...(a.index !== undefined ? { index: a.index } : {}),
      ...(a.transform ? { transform: a.transform } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  public async handleGameProceduralMesh(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.parentPath || !args.vertices) return createErrorResponse('parentPath and vertices are required.');
    return this.context.gameCommand('procedural_mesh', args, a => ({
      parent_path: a.parentPath, vertices: a.vertices,
      ...(a.normals ? { normals: a.normals } : {}),
      ...(a.uvs ? { uvs: a.uvs } : {}),
      ...(a.indices ? { indices: a.indices } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  public async handleGameLight3d(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.context.gameCommand('light_3d', args, a => ({
      action: a.action,
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.lightType ? { light_type: a.lightType } : {}),
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.color ? { color: a.color } : {}),
      ...(a.energy !== undefined ? { energy: a.energy } : {}),
      ...(a.range !== undefined ? { range: a.range } : {}),
      ...(a.shadows !== undefined ? { shadows: a.shadows } : {}),
      ...(a.spotAngle !== undefined ? { spot_angle: a.spotAngle } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  public async handleGameMeshInstance(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.parentPath || !args.meshType) return createErrorResponse('parentPath and meshType are required.');
    return this.context.gameCommand('mesh_instance', args, a => ({
      parent_path: a.parentPath, mesh_type: a.meshType,
      ...(a.size ? { size: a.size } : {}),
      ...(a.radius !== undefined ? { radius: a.radius } : {}),
      ...(a.height !== undefined ? { height: a.height } : {}),
      ...(a.material ? { material: a.material } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  public async handleGameGridmap(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    return this.context.gameCommand('gridmap', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.x !== undefined ? { x: a.x } : {}),
      ...(a.y !== undefined ? { y: a.y } : {}),
      ...(a.z !== undefined ? { z: a.z } : {}),
      ...(a.item !== undefined ? { item: a.item } : {}),
      ...(a.orientation !== undefined ? { orientation: a.orientation } : {}),
    }));
  }

  public async handleGame3dEffects(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.parentPath || !args.effectType) return createErrorResponse('parentPath and effectType are required.');
    return this.context.gameCommand('3d_effects', args, a => ({
      parent_path: a.parentPath, effect_type: a.effectType,
      ...(a.size ? { size: a.size } : {}),
      ...(a.intensity !== undefined ? { intensity: a.intensity } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  public async handleGameGi(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.parentPath || !args.giType) return createErrorResponse('parentPath and giType are required.');
    return this.context.gameCommand('gi', args, a => ({
      parent_path: a.parentPath, gi_type: a.giType,
      ...(a.size ? { size: a.size } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  public async handleGamePath3d(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    if (args.action === 'create' && !args.parentPath) return createErrorResponse('parentPath is required for create.');
    if (args.action !== 'create' && !args.nodePath) return createErrorResponse('nodePath is required for this action.');
    if (args.action === 'add_point' && !args.point) return createErrorResponse('point is required for add_point.');
    if (args.action === 'set_points' && !args.points) return createErrorResponse('points is required for set_points.');
    return this.context.gameCommand('path_3d', args, a => ({
      action: a.action,
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.points ? { points: a.points } : {}),
      ...(a.point ? { point: a.point } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  public async handleGameSky(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.context.gameCommand('sky', args, a => ({
      action: a.action,
      ...(a.skyType ? { sky_type: a.skyType } : {}),
      ...(a.topColor ? { top_color: a.topColor } : {}),
      ...(a.bottomColor ? { bottom_color: a.bottomColor } : {}),
      ...(a.sunEnergy !== undefined ? { sun_energy: a.sunEnergy } : {}),
      ...(a.groundColor ? { ground_color: a.groundColor } : {}),
    }));
  }

  public async handleGameCameraAttributes(args: ToolArguments) {
    args = normalizeParameters(args || {});
    return this.context.gameCommand('camera_attributes', args, a => ({
      action: a.action || 'get',
      ...(a.dofBlurFar !== undefined ? { dof_blur_far: a.dofBlurFar } : {}),
      ...(a.dofBlurNear !== undefined ? { dof_blur_near: a.dofBlurNear } : {}),
      ...(a.dofBlurAmount !== undefined ? { dof_blur_amount: a.dofBlurAmount } : {}),
      ...(a.exposureMultiplier !== undefined ? { exposure_multiplier: a.exposureMultiplier } : {}),
      ...(a.autoExposure !== undefined ? { auto_exposure: a.autoExposure } : {}),
      ...(a.autoExposureScale !== undefined ? { auto_exposure_scale: a.autoExposureScale } : {}),
    }));
  }

  public async handleGameNavigation3d(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.context.gameCommand('navigation_3d', args, a => ({
      action: a.action,
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.cellSize !== undefined ? { cell_size: a.cellSize } : {}),
      ...(a.agentRadius !== undefined ? { agent_radius: a.agentRadius } : {}),
      ...(a.agentHeight !== undefined ? { agent_height: a.agentHeight } : {}),
      ...(a.name ? { name: a.name } : {}),
    }), 30000);
  }

  public async handleGamePhysics3d(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.context.gameCommand('physics_3d', args, a => ({
      action: a.action,
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.from ? { from: a.from } : {}),
      ...(a.to ? { to: a.to } : {}),
      ...(a.collisionMask !== undefined ? { collision_mask: a.collisionMask } : {}),
    }), 15000);
  }

  // --- Batch 3: 2D Systems + Animation Advanced + Audio Effects ---

  public async handleGameCanvas(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.context.gameCommand('canvas', args, a => ({
      action: a.action,
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.layer !== undefined ? { layer: a.layer } : {}),
      ...(a.offset ? { offset: a.offset } : {}),
      ...(a.visible !== undefined ? { visible: a.visible } : {}),
      ...(a.color ? { color: a.color } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  public async handleGameCanvasDraw(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.context.gameCommand('canvas_draw', args, a => ({
      action: a.action,
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.from ? { from: a.from } : {}),
      ...(a.to ? { to: a.to } : {}),
      ...(a.center ? { center: a.center } : {}),
      ...(a.radius !== undefined ? { radius: a.radius } : {}),
      ...(a.rect ? { rect: a.rect } : {}),
      ...(a.points ? { points: a.points } : {}),
      ...(a.position ? { position: a.position } : {}),
      ...(a.text ? { text: a.text } : {}),
      ...(a.fontSize !== undefined ? { font_size: a.fontSize } : {}),
      ...(a.color ? { color: a.color } : {}),
      ...(a.width !== undefined ? { width: a.width } : {}),
      ...(a.filled !== undefined ? { filled: a.filled } : {}),
    }));
  }

  public async handleGameLight2d(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.context.gameCommand('light_2d', args, a => ({
      action: a.action,
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.color ? { color: a.color } : {}),
      ...(a.energy !== undefined ? { energy: a.energy } : {}),
      ...(a.range !== undefined ? { range: a.range } : {}),
      ...(a.points ? { points: a.points } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  public async handleGameParallax(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.context.gameCommand('parallax', args, a => ({
      action: a.action,
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.motionScale ? { motion_scale: a.motionScale } : {}),
      ...(a.motionOffset ? { motion_offset: a.motionOffset } : {}),
      ...(a.mirroring ? { mirroring: a.mirroring } : {}),
      ...(a.scrollOffset ? { scroll_offset: a.scrollOffset } : {}),
      ...(a.scrollBaseOffset ? { scroll_base_offset: a.scrollBaseOffset } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  public async handleGameShape2d(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    return this.context.gameCommand('shape_2d', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.points ? { points: a.points } : {}),
      ...(a.point ? { point: a.point } : {}),
      ...(a.width !== undefined ? { width: a.width } : {}),
      ...(a.color ? { color: a.color } : {}),
    }));
  }

  public async handleGamePath2d(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.context.gameCommand('path_2d', args, a => ({
      action: a.action,
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.points ? { points: a.points } : {}),
      ...(a.point ? { point: a.point } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  public async handleGamePhysics2d(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.context.gameCommand('physics_2d', args, a => ({
      action: a.action,
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.from ? { from: a.from } : {}),
      ...(a.to ? { to: a.to } : {}),
      ...(a.position ? { position: a.position } : {}),
      ...(a.point ? { point: a.point } : {}),
      ...(a.radius !== undefined ? { radius: a.radius } : {}),
      ...(a.size ? { size: a.size } : {}),
      ...(a.shapeType ? { shape_type: a.shapeType } : {}),
      ...(a.maxResults !== undefined ? { max_results: a.maxResults } : {}),
      ...(a.collideWithAreas !== undefined ? { collide_with_areas: a.collideWithAreas } : {}),
      ...(a.collideWithBodies !== undefined ? { collide_with_bodies: a.collideWithBodies } : {}),
      ...(a.collisionMask !== undefined ? { collision_mask: a.collisionMask } : {}),
    }), 15000);
  }

  public async handleGameAnimationTree(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    return this.context.gameCommand('animation_tree', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.stateName ? { state_name: a.stateName } : {}),
      ...(a.paramName ? { param_name: a.paramName } : {}),
      ...(a.paramValue !== undefined ? { param_value: a.paramValue } : {}),
    }));
  }

  public async handleGameAnimationControl(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    if (args.action === 'seek' && args.position === undefined) return createErrorResponse('position is required for seek.');
    if (args.action === 'queue' && !args.animationName) return createErrorResponse('animationName is required for queue.');
    if (args.action === 'set_speed' && args.speed === undefined) return createErrorResponse('speed is required for set_speed.');
    return this.context.gameCommand('animation_control', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.animationName ? { animation_name: a.animationName } : {}),
      ...(a.position !== undefined ? { position: a.position } : {}),
      ...(a.speed !== undefined ? { speed: a.speed } : {}),
    }));
  }

  public async handleGameSkeletonIk(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    return this.context.gameCommand('skeleton_ik', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.target ? { target: a.target } : {}),
    }));
  }

  public async handleGameAudioEffect(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.context.gameCommand('audio_effect', args, a => ({
      action: a.action, bus_name: a.busName || 'Master',
      ...(a.effectType ? { effect_type: a.effectType } : {}),
      ...(a.index !== undefined ? { index: a.index } : {}),
      ...(a.properties ? { properties: a.properties } : {}),
      ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
    }));
  }

  public async handleGameAudioBusLayout(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    if (['add', 'remove', 'move', 'set_send'].includes(args.action) && !args.busName) {
      return createErrorResponse('busName is required for this action.');
    }
    if (args.action === 'set_send' && !args.sendTo) return createErrorResponse('sendTo is required for set_send.');
    if (args.action === 'move' && args.index === undefined) return createErrorResponse('index is required for move.');
    return this.context.gameCommand('audio_bus_layout', args, a => ({
      action: a.action,
      ...(a.busName ? { bus_name: a.busName } : {}),
      ...(a.sendTo ? { send_to: a.sendTo } : {}),
      ...(a.index !== undefined ? { index: a.index } : {}),
    }));
  }

  public async handleGameAudioSpatial(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    return this.context.gameCommand('audio_spatial', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.maxDistance !== undefined ? { max_distance: a.maxDistance } : {}),
      ...(a.unitSize !== undefined ? { unit_size: a.unitSize } : {}),
      ...(a.maxDb !== undefined ? { max_db: a.maxDb } : {}),
      ...(a.attenuationModel ? { attenuation_model: a.attenuationModel } : {}),
    }));
  }

  // --- Batch 4: Editor/Headless + Localization + Resource ---

  public async handleGameLocale(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.context.gameCommand('locale', args, a => ({
      action: a.action,
      ...(a.locale ? { locale: a.locale } : {}),
      ...(a.key ? { key: a.key } : {}),
    }));
  }

  // --- Batch 5: UI Controls + Rendering + Resource Runtime ---

  public async handleGameUiControl(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    return this.context.gameCommand('ui_control', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.anchorPreset !== undefined ? { anchor_preset: a.anchorPreset } : {}),
      ...(a.tooltip !== undefined ? { tooltip: a.tooltip } : {}),
      ...(a.mouseFilter ? { mouse_filter: a.mouseFilter } : {}),
      ...(a.minSize ? { min_size: a.minSize } : {}),
    }));
  }

  public async handleGameUiText(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    if (['set', 'append', 'bbcode'].includes(args.action) && args.text === undefined) {
      return createErrorResponse('text is required for this action.');
    }
    if ((args.selectionFrom === undefined) !== (args.selectionTo === undefined)) {
      return createErrorResponse('selectionFrom and selectionTo must be provided together.');
    }
    return this.context.gameCommand('ui_text', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.text !== undefined ? { text: a.text } : {}),
      ...(a.caretPosition !== undefined ? { caret_position: a.caretPosition } : {}),
      ...(a.selectionFrom !== undefined ? { selection_from: a.selectionFrom } : {}),
      ...(a.selectionTo !== undefined ? { selection_to: a.selectionTo } : {}),
    }));
  }

  public async handleGameUiPopup(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    return this.context.gameCommand('ui_popup', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.size ? { size: a.size } : {}),
      ...(a.title !== undefined ? { title: a.title } : {}),
      ...(a.text !== undefined ? { text: a.text } : {}),
    }));
  }

  public async handleGameUiTree(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    if (args.action === 'add' && args.text === undefined) return createErrorResponse('text is required for add.');
    if (['select', 'collapse', 'expand', 'remove'].includes(args.action) && !args.itemPath) {
      return createErrorResponse('itemPath is required for this action.');
    }
    return this.context.gameCommand('ui_tree', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.itemPath ? { item_path: a.itemPath } : {}),
      ...(a.text !== undefined ? { text: a.text } : {}),
      ...(a.column !== undefined ? { column: a.column } : {}),
    }));
  }

  public async handleGameUiItemList(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    if (['select', 'remove'].includes(args.action) && args.index === undefined) {
      return createErrorResponse('index is required for this action.');
    }
    if (args.action === 'add' && args.text === undefined) return createErrorResponse('text is required for add.');
    return this.context.gameCommand('ui_item_list', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.index !== undefined ? { index: a.index } : {}),
      ...(a.text ? { text: a.text } : {}),
    }));
  }

  public async handleGameUiTabs(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    if (['set_current', 'set_title'].includes(args.action) && args.index === undefined) {
      return createErrorResponse('index is required for this action.');
    }
    if (args.action === 'set_title' && args.title === undefined) return createErrorResponse('title is required for set_title.');
    return this.context.gameCommand('ui_tabs', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.index !== undefined ? { index: a.index } : {}),
      ...(a.title !== undefined ? { title: a.title } : {}),
    }));
  }

  public async handleGameUiMenu(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    if (args.action === 'add' && args.text === undefined) return createErrorResponse('text is required for add.');
    if (['remove', 'set_checked'].includes(args.action) && args.index === undefined) {
      return createErrorResponse('index is required for this action.');
    }
    if (args.action === 'set_checked' && args.checked === undefined) return createErrorResponse('checked is required for set_checked.');
    return this.context.gameCommand('ui_menu', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.index !== undefined ? { index: a.index } : {}),
      ...(a.text !== undefined ? { text: a.text } : {}),
      ...(a.checked !== undefined ? { checked: a.checked } : {}),
      ...(a.id !== undefined ? { id: a.id } : {}),
      ...(a.shortcutKey !== undefined ? { shortcut_key: a.shortcutKey } : {}),
    }));
  }

  public async handleGameUiRange(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    if (args.action === 'set' && args.value === undefined && args.minValue === undefined
      && args.maxValue === undefined && args.step === undefined && !args.color) {
      return createErrorResponse('set requires a value, range setting, or color.');
    }
    return this.context.gameCommand('ui_range', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.value !== undefined ? { value: a.value } : {}),
      ...(a.minValue !== undefined ? { min_value: a.minValue } : {}),
      ...(a.maxValue !== undefined ? { max_value: a.maxValue } : {}),
      ...(a.step !== undefined ? { step: a.step } : {}),
      ...(a.color ? { color: a.color } : {}),
    }));
  }

  public async handleGameRenderSettings(args: ToolArguments) {
    args = normalizeParameters(args || {});
    return this.context.gameCommand('render_settings', args, a => ({
      action: a.action || 'get',
      ...(a.msaa2d !== undefined ? { msaa_2d: a.msaa2d } : {}),
      ...(a.msaa3d !== undefined ? { msaa_3d: a.msaa3d } : {}),
      ...(a.fxaa !== undefined ? { fxaa: a.fxaa } : {}),
      ...(a.taa !== undefined ? { taa: a.taa } : {}),
      ...(a.scalingMode !== undefined ? { scaling_mode: a.scalingMode } : {}),
      ...(a.scalingScale !== undefined ? { scaling_scale: a.scalingScale } : {}),
    }));
  }

  public async handleGameResource(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action || !args.path) return createErrorResponse('action and path are required.');
    return this.context.gameCommand('resource', args, a => ({
      action: a.action, path: a.path,
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.property ? { property: a.property } : {}),
    }));
  }

  // --- Batch 6: Visual Shader + Terrain + Video + CI/CD ---

  public async handleGameVisualShader(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.context.gameCommand('visual_shader', args, a => ({
      action: a.action,
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.shaderType ? { shader_type: a.shaderType } : {}),
      ...(a.nodeClass ? { node_class: a.nodeClass } : {}),
      ...(a.position ? { position: a.position } : {}),
      ...(a.fromNode !== undefined ? { from_node: a.fromNode } : {}),
      ...(a.fromPort !== undefined ? { from_port: a.fromPort } : {}),
      ...(a.toNode !== undefined ? { to_node: a.toNode } : {}),
      ...(a.toPort !== undefined ? { to_port: a.toPort } : {}),
      ...(a.shaderId !== undefined ? { shader_id: a.shaderId } : {}),
    }));
  }

  public async handleGameTerrain(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    if (args.action === 'create' && !args.parentPath) return createErrorResponse('parentPath is required for create.');
    if (args.action !== 'create' && !args.nodePath) return createErrorResponse('nodePath is required for this action.');
    if (args.action === 'get_height' && (args.x === undefined || args.z === undefined)) {
      return createErrorResponse('x and z are required for get_height.');
    }
    if (args.action === 'modify' && (args.x === undefined || args.z === undefined || args.radius === undefined || args.heightDelta === undefined)) {
      return createErrorResponse('x, z, radius, and heightDelta are required for modify.');
    }
    if (args.action === 'paint' && (args.x === undefined || args.z === undefined || args.radius === undefined || !args.color)) {
      return createErrorResponse('x, z, radius, and color are required for paint.');
    }
    return this.context.gameCommand('terrain', args, a => ({
      action: a.action,
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.heightData ? { height_data: a.heightData } : {}),
      ...(a.width !== undefined ? { width: a.width } : {}),
      ...(a.depth !== undefined ? { depth: a.depth } : {}),
      ...(a.maxHeight !== undefined ? { max_height: a.maxHeight } : {}),
      ...(a.x !== undefined ? { x: a.x } : {}),
      ...(a.z !== undefined ? { z: a.z } : {}),
      ...(a.radius !== undefined ? { radius: a.radius } : {}),
      ...(a.heightDelta !== undefined ? { height_delta: a.heightDelta } : {}),
      ...(a.color ? { color: a.color } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  public async handleGameVideo(args: ToolArguments) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.context.gameCommand('video', args, a => ({
      action: a.action,
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.videoPath ? { video_path: a.videoPath } : {}),
      ...(a.position !== undefined ? { position: a.position } : {}),
      ...(a.volume !== undefined ? { volume: a.volume } : {}),
      ...(a.loop !== undefined ? { loop: a.loop } : {}),
      ...(a.autoplay !== undefined ? { autoplay: a.autoplay } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }
}
