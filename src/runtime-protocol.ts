/** Versioned JSON-RPC 2.0 contract for the Godot runtime TCP endpoint. */
export const RUNTIME_PROTOCOL_VERSION = '1.0';
export const RUNTIME_CAPABILITIES = ['runtime-commands', 'godot-json-values'] as const;
export const HANDSHAKE_METHOD = 'godot.runtime.handshake';
export const COMMAND_METHOD_PREFIX = 'godot.runtime.';
export const CANCEL_METHOD = 'godot.runtime.cancel';
export const CANCELLABLE_RUNTIME_COMMANDS = ['wait', 'await_signal'] as const;

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
