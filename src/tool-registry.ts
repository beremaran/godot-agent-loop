import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { toolDefinitions } from './tool-definitions.js';
import { createToolArgumentParser, ToolArgumentValidationError } from './tool-argument-validation.js';
import type { ToolArguments, ToolResponse } from './utils.js';

// Tool handlers return the MCP SDK's structurally-typed result objects. Keeping
// this generic avoids coupling the registry to one request schema revision.
export type ToolHandler = (args: ToolArguments) => Promise<ToolResponse>;
export type ToolPreflight = (
  name: string,
  args: ToolArguments,
) => ToolResponse | undefined | Promise<ToolResponse | undefined>;

/**
 * Dispatches MCP tool calls to their handlers.
 */
export class ToolRegistry<ToolName extends string> {
  private readonly handlers = new Map<string, ToolHandler>();
  private readonly parseArguments = createToolArgumentParser(toolDefinitions);

  constructor(
    handlers: Record<ToolName, ToolHandler>,
    private readonly preflight?: ToolPreflight,
  ) {
    this.handlers = new Map(Object.entries(handlers));
  }

  dispatch(name: string, args: unknown): Promise<ToolResponse> {
    const handler = this.handlers.get(name);
    if (!handler) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    try {
      const parsed = this.parseArguments(name, args);
      if (!this.preflight) return handler(parsed);
      return Promise.resolve(this.preflight(name, parsed))
        .then(blocked => blocked ?? handler(parsed));
    } catch (error) {
      if (error instanceof ToolArgumentValidationError) {
        throw new McpError(ErrorCode.InvalidParams, error.message);
      }
      throw error;
    }
  }
}
