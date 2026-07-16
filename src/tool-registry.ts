import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { toolDefinitions } from './tool-definitions.js';
import { createToolArgumentParser, ToolArgumentValidationError } from './tool-argument-validation.js';
import {
  createExecutionContext,
  isAbortError,
  runWithExecutionContext,
  setToolResultMetadata,
  throwIfCancelled,
  type ToolExecutionContext,
  type ToolExecutionContextResolverOptions,
  type ToolRequestContextSeed,
} from './execution-context.js';
import type { ToolArguments, ToolResponse } from './utils.js';
import { createErrorResponse } from './utils.js';
import { argumentToolError } from './tool-results.js';

// Tool handlers return the MCP SDK's structurally-typed result objects. Keeping
// this generic avoids coupling the registry to one request schema revision.
export type ToolHandler = (args: ToolArguments) => Promise<ToolResponse>;
export type ToolPreflight = (
  name: string,
  args: ToolArguments,
  context: ToolExecutionContext,
) => ToolResponse | undefined | Promise<ToolResponse | undefined>;

export interface ToolRegistryOptions {
  context?: ToolExecutionContextResolverOptions;
  onStart?: (context: ToolExecutionContext) => void | Promise<void>;
  onFinish?: (context: ToolExecutionContext, response: ToolResponse) => ToolResponse | Promise<ToolResponse>;
  onError?: (context: ToolExecutionContext, error: unknown) => void | Promise<void>;
}

/**
 * Dispatches MCP tool calls to their handlers.
 */
export class ToolRegistry<ToolName extends string> {
  private readonly handlers = new Map<string, ToolHandler>();
  private readonly parseArguments = createToolArgumentParser(toolDefinitions);

  constructor(
    handlers: Record<ToolName, ToolHandler>,
    private readonly preflight?: ToolPreflight,
    private readonly options: ToolRegistryOptions = {},
  ) {
    this.handlers = new Map(Object.entries(handlers));
  }

  dispatch(name: string, args: unknown, seed: ToolRequestContextSeed = {}): Promise<ToolResponse> {
    const handler = this.handlers.get(name);
    if (!handler) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    let parsed: ToolArguments;
    try {
      parsed = this.parseArguments(name, args);
    } catch (error) {
      if (!(error instanceof ToolArgumentValidationError)) throw error;
      const raw = args && typeof args === 'object' && !Array.isArray(args) ? args as ToolArguments : {};
      const context = createExecutionContext(name, raw, seed, undefined, this.options.context);
      return runWithExecutionContext(context, async () => {
        await this.options.onStart?.(context);
        const firstIssue = error.details[0];
        const response = setToolResultMetadata(createErrorResponse(error.message), {
          outcome: 'failure',
          error: argumentToolError(error.message, firstIssue?.path, error.details),
        });
        return this.options.onFinish ? await this.options.onFinish(context, response) : response;
      });
    }
    const context = createExecutionContext(name, parsed, seed, undefined, this.options.context);
    return runWithExecutionContext(context, async () => {
      try {
        await this.options.onStart?.(context);
        throwIfCancelled(context.signal);
        const blocked = this.preflight
          ? await (this.preflight.length >= 3
            ? this.preflight(name, parsed, context)
            : (this.preflight as (toolName: string, toolArgs: ToolArguments) => ReturnType<ToolPreflight>)(name, parsed))
          : undefined;
        // A pause-state query is asynchronous. Cancellation that arrives
        // while that guard is checking must still win before a paused result
        // or a handler can become the request's terminal outcome.
        throwIfCancelled(context.signal);
        const response = blocked ?? await handler(parsed);
        return this.options.onFinish ? await this.options.onFinish(context, response) : response;
      } catch (error) {
        if (isAbortError(error)) {
          const abort = error as Error;
          const response = setToolResultMetadata(createErrorResponse(`Tool call cancelled: ${abort.message}`), {
            outcome: 'cancelled',
            error: {
              code: 'cancelled',
              category: 'cancelled',
              message: abort.message,
              retryable: true,
              remediation: 'Retry when the client is ready to let the operation complete.',
            },
          });
          return this.options.onFinish ? await this.options.onFinish(context, response) : response;
        }
        await this.options.onError?.(context, error);
        throw error;
      }
    });
  }
}
