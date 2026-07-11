import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

// Tool handlers return the MCP SDK's structurally-typed result objects. Keeping
// this generic avoids coupling the registry to one request schema revision.
export type ToolHandler = (args: unknown) => Promise<any>;

/**
 * Dispatches MCP tool calls to their handlers.
 */
export class ToolRegistry<ToolName extends string> {
  private readonly handlers = new Map<string, ToolHandler>();

  constructor(handlers: Record<ToolName, ToolHandler>) {
    this.handlers = new Map(Object.entries(handlers));
  }

  dispatch(name: string, args: unknown): Promise<any> {
    const handler = this.handlers.get(name);
    if (!handler) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    return handler(args);
  }
}
