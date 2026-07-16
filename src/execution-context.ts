import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { PRIVILEGED_RUNTIME_COMMAND_GROUPS, type PrivilegedRuntimeGroup } from './runtime-protocol.js';
import { toolManifest } from './tool-manifest.js';
import { isToolCallAllowedWhilePaused, isToolCallMutating } from './tool-mutation-policy.js';
import type { ToolArguments, ToolResponse } from './utils.js';
import type { StructuredToolError } from './tool-results.js';

export type ToolEffectScope =
  | 'read-only'
  | 'project-persistent'
  | 'runtime-ephemeral'
  | 'process'
  | 'external-open-world';

export type ToolExecutionOutcome =
  | 'success'
  | 'failure'
  | 'timeout'
  | 'fallback'
  | 'paused'
  | 'conflict'
  | 'cancelled';

export interface ToolProgressReporter {
  report(progress: number, total: number, message?: string): Promise<void>;
}

export interface ToolRequestContextSeed {
  requestId?: string | number;
  signal?: AbortSignal;
  progress?: ToolProgressReporter;
}

export interface ToolExecutionContext {
  requestId: string | number;
  startedAt: number;
  traceId: string;
  parentTraceId?: string;
  advertisedToolName: string;
  invocationToolName: string;
  effectiveToolName: string;
  effectiveArguments: ToolArguments;
  projectPath?: string;
  connectionIdentity?: string;
  domain: string;
  backend: string;
  effectScope: ToolEffectScope;
  privilegeGroup?: PrivilegedRuntimeGroup;
  mutating: boolean;
  safeWhilePaused: boolean;
  signal: AbortSignal;
  progress?: ToolProgressReporter;
}

export interface ToolExecutionContextResolverOptions {
  resolveProject?: (
    invocationToolName: string,
    effectiveToolName: string,
    args: ToolArguments,
    effectiveArgs: ToolArguments,
    parent?: ToolExecutionContext,
  ) => { projectPath?: string; connectionIdentity?: string } | undefined;
}

export interface ToolResultMetadata {
  outcome?: ToolExecutionOutcome;
  effectiveToolName?: string;
  synchronized?: boolean;
  details?: Record<string, unknown>;
  error?: StructuredToolError;
  structured?: boolean;
}

const executionStorage = new AsyncLocalStorage<ToolExecutionContext>();
const responseMetadata = new WeakMap<object, ToolResultMetadata>();
const NEVER_ABORTED_SIGNAL = new AbortController().signal;

const DISPATCHERS = new Set(['godot_tools', 'godot_call']);

export function currentExecutionContext(): ToolExecutionContext | undefined {
  return executionStorage.getStore();
}

export function runWithExecutionContext<T>(
  context: ToolExecutionContext,
  operation: () => T,
): T {
  return executionStorage.run(context, operation);
}

export function createExecutionContext(
  invocationToolName: string,
  args: ToolArguments,
  seed: ToolRequestContextSeed = {},
  parent = currentExecutionContext(),
  options: ToolExecutionContextResolverOptions = {},
): ToolExecutionContext {
  const nested = effectiveCall(invocationToolName, args);
  const manifest = toolManifest[nested.name as keyof typeof toolManifest];
  const project = options.resolveProject?.(
    invocationToolName, nested.name, args, nested.args, parent,
  );
  const backend = manifest?.backend.kind ?? 'unknown';
  const mutating = isToolCallMutating(nested.name, nested.args);
  const signal = seed.signal ?? parent?.signal ?? NEVER_ABORTED_SIGNAL;
  return {
    requestId: seed.requestId ?? parent?.requestId ?? randomUUID(),
    startedAt: Date.now(),
    traceId: randomUUID(),
    ...(parent ? { parentTraceId: parent.traceId } : {}),
    advertisedToolName: parent?.advertisedToolName ?? invocationToolName,
    invocationToolName,
    effectiveToolName: nested.name,
    effectiveArguments: nested.args,
    ...(project?.projectPath ? { projectPath: project.projectPath } : parent?.projectPath ? { projectPath: parent.projectPath } : {}),
    ...(project?.connectionIdentity ? { connectionIdentity: project.connectionIdentity }
      : parent?.connectionIdentity ? { connectionIdentity: parent.connectionIdentity } : {}),
    domain: manifest?.domain ?? 'unknown',
    backend,
    effectScope: effectScope(nested.name, manifest?.domain, backend, mutating),
    ...(privilegeGroup(manifest?.backend) ? { privilegeGroup: privilegeGroup(manifest?.backend) } : {}),
    mutating,
    safeWhilePaused: isToolCallAllowedWhilePaused(nested.name, nested.args),
    signal,
    progress: seed.progress ?? parent?.progress,
  };
}

export function setToolResultMetadata<T extends ToolResponse>(
  response: T,
  metadata: ToolResultMetadata,
): T {
  const existing = responseMetadata.get(response) ?? {};
  responseMetadata.set(response, { ...existing, ...metadata });
  return response;
}

export function getToolResultMetadata(response: ToolResponse): ToolResultMetadata {
  return responseMetadata.get(response) ?? {};
}

export function copyToolResultMetadata(from: ToolResponse, to: ToolResponse): ToolResponse {
  const metadata = responseMetadata.get(from);
  if (metadata) responseMetadata.set(to, { ...metadata });
  return to;
}

export function throwIfCancelled(signal = currentExecutionContext()?.signal): void {
  if (signal?.aborted) throw abortError(signal.reason);
}

export async function cancellableDelay(milliseconds: number, signal = currentExecutionContext()?.signal): Promise<void> {
  throwIfCancelled(signal);
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError(signal?.reason));
    };
    function done(): void {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function reportProgress(progress: number, total: number, message?: string): Promise<void> {
  const reporter = currentExecutionContext()?.progress;
  if (reporter) await reporter.report(progress, total, message);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function abortError(reason?: unknown): Error {
  const message = reason instanceof Error ? reason.message
    : typeof reason === 'string' && reason.length > 0 ? reason
      : 'Operation cancelled';
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function effectiveCall(name: string, args: ToolArguments): { name: string; args: ToolArguments } {
  const dispatches = name === 'godot_call' || (name === 'godot_tools' && args.action === 'call');
  if (!DISPATCHERS.has(name) || !dispatches || typeof args.toolName !== 'string') {
    return { name, args };
  }
  const nestedArgs = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
    ? args.arguments as ToolArguments
    : {};
  return { name: args.toolName, args: nestedArgs };
}

function effectScope(name: string, domain: string | undefined, backend: string, mutating: boolean): ToolEffectScope {
  if (!mutating) return 'read-only';
  if (name === 'game_http_request' || name === 'game_websocket' || name === 'game_multiplayer' || name === 'game_rpc') {
    return 'external-open-world';
  }
  if (domain === 'game' || backend === 'runtime') return 'runtime-ephemeral';
  if (domain === 'project' || backend === 'authoring-session' || backend === 'godot-cli') return 'project-persistent';
  return 'process';
}

function privilegeGroup(backend: unknown): PrivilegedRuntimeGroup | undefined {
  if (!backend || typeof backend !== 'object' || !('command' in backend)) return undefined;
  const command = (backend as { command?: unknown }).command;
  return typeof command === 'string'
    ? PRIVILEGED_RUNTIME_COMMAND_GROUPS[command as keyof typeof PRIVILEGED_RUNTIME_COMMAND_GROUPS]
    : undefined;
}
