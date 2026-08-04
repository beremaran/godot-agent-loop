/** Versioned JSON-RPC 2.0 contract for the Godot runtime TCP endpoint. */
export const RUNTIME_PROTOCOL_VERSION = '1.0';
export const RUNTIME_CAPABILITIES = ['runtime-commands', 'godot-json-values'] as const;
export const RENDERING_CONTEXT_CAPABILITY = 'rendering-context' as const;
export const HANDSHAKE_METHOD = 'godot.runtime.handshake';
export const COMMAND_METHOD_PREFIX = 'godot.runtime.';
export const CANCEL_METHOD = 'godot.runtime.cancel';
export const CANCELLABLE_RUNTIME_COMMANDS = ['wait', 'await_signal'] as const;
export const PRIVILEGED_RUNTIME_CAPABILITY = 'privileged-commands' as const;
export const SESSION_AUTHENTICATION_CAPABILITY = 'session-authentication' as const;
export const PRIVILEGED_RUNTIME_GROUPS = ['reflection', 'code-execution'] as const;
export type PrivilegedRuntimeGroup = (typeof PRIVILEGED_RUNTIME_GROUPS)[number];
export const PRIVILEGED_RUNTIME_COMMANDS = [
  'call_method',
  'eval',
  'get_property',
  'script',
  'set_property',
] as const;
export const PRIVILEGED_RUNTIME_COMMAND_GROUPS: Readonly<Record<(typeof PRIVILEGED_RUNTIME_COMMANDS)[number], PrivilegedRuntimeGroup>> = {
  call_method: 'reflection',
  eval: 'code-execution',
  get_property: 'reflection',
  script: 'code-execution',
  set_property: 'reflection',
};

export function privilegedGroupCapability(group: PrivilegedRuntimeGroup): string {
  return `privileged-${group}`;
}

/**
 * Every runtime command in the published contract, sorted. The manifest of
 * record is `x-runtime-contract.commands` in docs/runtime-api.schema.json;
 * this mirror lets the TypeScript binding reject unknown commands before they
 * reach the wire, and the contract test verifies the two never drift.
 */
export const RUNTIME_COMMANDS = [
  'await_signal',
  'call_method',
  'change_scene',
  'click',
  'connect_signal',
  'disconnect_signal',
  'emit_signal',
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
  'input_action',
  'input_state',
  'instantiate_scene',
  'key_hold',
  'key_press',
  'key_release',
  'list_signals',
  'manage_group',
  'mouse_drag',
  'mouse_move',
  'os_info',
  'pause',
  'remove_node',
  'reparent_node',
  'screenshot',
  'script',
  'scroll',
  'set_property',
  'spawn_node',
  'time_scale',
  'touch',
  'wait',
] as const;

export type RuntimeCommand = (typeof RUNTIME_COMMANDS)[number];
const RUNTIME_COMMAND_SET: ReadonlySet<string> = new Set(RUNTIME_COMMANDS);

export type SessionCommand = RuntimeCommand;
export const SESSION_COMMANDS = [...RUNTIME_COMMANDS].sort();

export function isRuntimeCommand(command: string): command is RuntimeCommand {
  return RUNTIME_COMMAND_SET.has(command);
}

export function isSessionCommand(command: string): command is SessionCommand {
  return isRuntimeCommand(command);
}

export type JsonRpcId = number | string;
export interface JsonRpcRequest { jsonrpc: '2.0'; id: JsonRpcId; method: string; params?: Record<string, unknown>; }
export interface JsonRpcError { code: number; message: string; data?: unknown; }
export interface JsonRpcSuccess<T = unknown> { jsonrpc: '2.0'; id: JsonRpcId; result: T; }
export interface JsonRpcFailure { jsonrpc: '2.0'; id: JsonRpcId | null; error: JsonRpcError; }
export type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcFailure;
export interface RuntimeHandshake {
  protocolVersion: string;
  capabilities: string[];
  engineVersion?: string;
  projectPath?: string;
  currentScene?: string;
}

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
