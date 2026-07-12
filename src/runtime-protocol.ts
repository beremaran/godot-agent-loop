/** Versioned JSON-RPC 2.0 contract for the Godot runtime TCP endpoint. */
export const RUNTIME_PROTOCOL_VERSION = '1.0';
export const RUNTIME_CAPABILITIES = ['runtime-commands', 'godot-json-values'] as const;
export const HANDSHAKE_METHOD = 'godot.runtime.handshake';
export const COMMAND_METHOD_PREFIX = 'godot.runtime.';
export const CANCEL_METHOD = 'godot.runtime.cancel';
export const CANCELLABLE_RUNTIME_COMMANDS = ['wait', 'await_signal'] as const;

/**
 * Every runtime command in the published contract, sorted. The manifest of
 * record is `x-runtime-contract.commands` in docs/runtime-api.schema.json;
 * this mirror lets the TypeScript binding reject unknown commands before they
 * reach the wire, and the contract test verifies the two never drift.
 */
export const RUNTIME_COMMANDS = [
  '3d_effects',
  'add_collision',
  'animation_control',
  'animation_tree',
  'audio_bus',
  'audio_bus_layout',
  'audio_effect',
  'audio_play',
  'audio_spatial',
  'await_signal',
  'bone_pose',
  'call_method',
  'camera_attributes',
  'canvas',
  'canvas_draw',
  'change_scene',
  'click',
  'connect_signal',
  'create_animation',
  'create_joint',
  'create_timer',
  'csg',
  'debug_draw',
  'disconnect_signal',
  'emit_signal',
  'environment',
  'eval',
  'find_nodes_by_class',
  'gamepad',
  'get_audio',
  'get_camera',
  'get_node_info',
  'get_nodes_in_group',
  'get_performance',
  'get_property',
  'get_scene_tree',
  'get_ui_elements',
  'gi',
  'gridmap',
  'http_request',
  'input_action',
  'input_state',
  'instantiate_scene',
  'key_hold',
  'key_press',
  'key_release',
  'light_2d',
  'light_3d',
  'list_signals',
  'locale',
  'manage_group',
  'mesh_instance',
  'mouse_drag',
  'mouse_move',
  'multimesh',
  'multiplayer',
  'navigate_path',
  'navigation_3d',
  'os_info',
  'parallax',
  'path_2d',
  'path_3d',
  'pause',
  'physics_2d',
  'physics_3d',
  'physics_body',
  'play_animation',
  'procedural_mesh',
  'process_mode',
  'raycast',
  'remove_node',
  'render_settings',
  'reparent_node',
  'resource',
  'rpc',
  'screenshot',
  'script',
  'scroll',
  'serialize_state',
  'set_camera',
  'set_particles',
  'set_property',
  'set_shader_param',
  'shape_2d',
  'skeleton_ik',
  'sky',
  'spawn_node',
  'terrain',
  'tilemap',
  'time_scale',
  'touch',
  'tween_property',
  'ui_control',
  'ui_item_list',
  'ui_menu',
  'ui_popup',
  'ui_range',
  'ui_tabs',
  'ui_text',
  'ui_theme',
  'ui_tree',
  'video',
  'viewport',
  'visual_shader',
  'wait',
  'websocket',
  'window',
  'world_settings',
] as const;

export type RuntimeCommand = (typeof RUNTIME_COMMANDS)[number];
const RUNTIME_COMMAND_SET: ReadonlySet<string> = new Set(RUNTIME_COMMANDS);

export function isRuntimeCommand(command: string): command is RuntimeCommand {
  return RUNTIME_COMMAND_SET.has(command);
}

export type JsonRpcId = number | string;
export interface JsonRpcRequest { jsonrpc: '2.0'; id: JsonRpcId; method: string; params?: Record<string, unknown>; }
export interface JsonRpcError { code: number; message: string; data?: unknown; }
export interface JsonRpcSuccess<T = unknown> { jsonrpc: '2.0'; id: JsonRpcId; result: T; }
export interface JsonRpcFailure { jsonrpc: '2.0'; id: JsonRpcId | null; error: JsonRpcError; }
export type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcFailure;
export interface RuntimeHandshake { protocolVersion: string; capabilities: string[]; }

export function commandMethod(command: string): string { return `${COMMAND_METHOD_PREFIX}${command}`; }
export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  return response.jsonrpc === '2.0'
    && (typeof response.id === 'number' || typeof response.id === 'string' || response.id === null)
    && (Object.hasOwn(response, 'result') || typeof response.error === 'object');
}
export function isHandshakeResult(value: unknown): value is RuntimeHandshake {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return typeof result.protocolVersion === 'string' && Array.isArray(result.capabilities)
    && result.capabilities.every(capability => typeof capability === 'string');
}
