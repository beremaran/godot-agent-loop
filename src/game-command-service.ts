import { createErrorResponse, convertCamelToSnakeCase, errorMessage, normalizeParameters, type OperationParams, type ToolArguments, type ToolResponse } from './utils.js';
import type { GodotProcessManager } from './godot-process-manager.js';
import type { GameConnection } from './game-connection.js';

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
    return this.connection.connected;
  }

  public readNewErrors(): string[] {
    return this.processManager.readNewErrors();
  }

  public readNewLogs(): string[] {
    return this.processManager.readNewLogs();
  }

  public send(command: string, params: Record<string, unknown> = {}, timeoutMs = 10000): Promise<GameResponse> {
    return this.connection.send(command, params, timeoutMs);
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
      if (response.error) return createErrorResponse(`${name} failed: ${response.error}`);
      return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
    } catch (error: unknown) {
      return createErrorResponse(`${name} failed: ${errorMessage(error)}`);
    }
  }
}

export interface GameResponse {
  id?: number;
  error?: string;
  [key: string]: unknown;
}
