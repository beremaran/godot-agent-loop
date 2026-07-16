import { createErrorResponse, convertCamelToSnakeCase, errorMessage, normalizeParameters, type OperationParams, type ToolArguments, type ToolResponse } from './utils.js';
import type { GodotProcessManager } from './godot-process-manager.js';
import type { GameConnection, GameResponse } from './game-connection.js';
import { currentExecutionContext, isAbortError, setToolResultMetadata } from './execution-context.js';
import { createBoundedObservationResponse, type ObservationResultOptions } from './observation-result.js';

const RUNTIME_OBSERVATIONS: Record<string, ObservationResultOptions> = {
  get_scene_tree: {
    preferredArrayKeys: ['children'],
    returnedCount: payload => countTreeNodes(payload.tree),
    sourceTruncated: payload => payload.truncated === true,
    refinement: 'Retry game_get_scene_tree with a smaller maxNodes value.',
    continuation: 'Use game_get_node_info with a specific nodePath to inspect a narrowed subtree.',
  },
  get_ui_elements: {
    preferredArrayKeys: ['elements'],
    returnedCount: payload => Array.isArray(payload.elements) ? payload.elements.length : 0,
    sourceTruncated: payload => payload.truncated === true,
    refinement: 'Use game_get_scene_tree to identify a specific UI node, then inspect it with game_get_node_info.',
    continuation: 'Inspect a named UI node directly with game_get_node_info.',
  },
  get_node_info: {
    preferredArrayKeys: ['methods', 'properties', 'signals', 'children'],
    returnedCount: payload => ['properties', 'signals', 'methods', 'children'].reduce(
      (count, key) => count + (Array.isArray(payload[key]) ? payload[key].length : 0),
      0,
    ),
    sourceTruncated: payload => payload.truncated === true,
    refinement: 'Use game_get_property for a named property or game_get_scene_tree with maxNodes to narrow the inspection.',
    continuation: 'Request specific values with game_get_property instead of repeating the full node description.',
  },
};

function countTreeNodes(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const node = value as Record<string, unknown>;
  return 1 + (Array.isArray(node.children)
    ? node.children.reduce((count: number, child: unknown) => count + countTreeNodes(child), 0)
    : 0);
}

/** Shared runtime command boundary for tools that control a running game. */
export class GameCommandService {
  constructor(
    private readonly processManager: GodotProcessManager,
    private readonly connection: GameConnection,
  ) {}

  public hasActiveProcess(): boolean {
    return this.processManager.activeProcess !== null;
  }

  public isConnected(): boolean {
    return this.connection.isConnected;
  }

  public connectedProjectPath(): string | null {
    return this.connection.connectedProjectPath;
  }

  public readNewErrors(limit?: number): { items: string[]; remaining: number; byteLimited: boolean } {
    return this.processManager.readNewErrors(limit);
  }

  public readNewLogs(limit?: number): { items: string[]; remaining: number; byteLimited: boolean } {
    return this.processManager.readNewLogs(limit);
  }

  public send(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10000,
    signal: AbortSignal | null | undefined = currentExecutionContext()?.signal,
  ): Promise<GameResponse> {
    return this.connection.send(command, params, timeoutMs, signal ?? undefined);
  }

  /**
   * Performs the common runtime checks and formats regular command responses.
   * Parameter mapping remains in the domain handler, where each tool's
   * request shape is explicit.
   */
  public async execute(
    name: string,
    args: unknown,
    buildParams: (args: ToolArguments) => Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<ToolResponse> {
    if (!this.hasActiveProcess()) return createErrorResponse('No active Godot process. Use run_project first.');
    if (!this.isConnected()) return createErrorResponse('Not connected to game interaction server.');

    const normalizedArgs = normalizeParameters((args || {}) as OperationParams);
    try {
      const response = await this.send(name, convertCamelToSnakeCase(buildParams(normalizedArgs)), timeoutMs);
      if ('error' in response) return createErrorResponse(`${name} failed: ${response.error.message}`);
      const observation = RUNTIME_OBSERVATIONS[name];
      if (observation && response.result && typeof response.result === 'object' && !Array.isArray(response.result)) {
        return createBoundedObservationResponse(response.result as Record<string, unknown>, observation);
      }
      return { content: [{ type: 'text', text: JSON.stringify(response.result, null, 2) }] };
    } catch (error: unknown) {
      return setToolResultMetadata(createErrorResponse(`${name} failed: ${errorMessage(error)}`), {
        outcome: isAbortError(error) ? 'cancelled' : 'failure',
      });
    }
  }
}
