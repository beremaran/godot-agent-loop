import { validateAgainstSchema } from './tool-argument-validation.js';
import { toolDefinitions } from './tool-definitions.js';
import type { ToolEffectScope } from './tool-catalog-metadata.js';
import { COMMON_STRUCTURED_RESULT_SCHEMA } from './tool-output-schema.js';
import type { ToolResponse } from './utils.js';

export { COMMON_STRUCTURED_RESULT_SCHEMA } from './tool-output-schema.js';

export type ToolErrorCategory =
  | 'argument'
  | 'policy'
  | 'precondition'
  | 'engine'
  | 'timeout'
  | 'cancelled'
  | 'conflict'
  | 'internal';

export interface StructuredToolError extends Record<string, unknown> {
  code: string;
  category: ToolErrorCategory;
  message: string;
  field?: string;
  retryable: boolean;
  remediation: string;
  details?: unknown;
}

export interface StructuredToolMeta extends Record<string, unknown> {
  advertisedTool: string;
  effectiveTool: string;
  backend?: string;
  projectPath?: string;
  effectScope: ToolEffectScope;
  privilegeGroup?: string;
  traceId?: string;
  parentTraceId?: string;
  durationMs: number;
  warnings: string[];
  fallback?: boolean;
  synchronization?: string;
  synchronizationEvidence?: unknown;
  cleanup?: unknown;
}

export interface StructuredToolContent extends Record<string, unknown> {
  ok: boolean;
  data?: unknown;
  meta: StructuredToolMeta;
  error?: StructuredToolError;
}

export interface ToolResultContext {
  advertisedTool: string;
  effectiveTool: string;
  effectScope: ToolEffectScope;
  backend?: string;
  privilegeGroup?: string;
  startedAt: number;
  projectPath?: string;
  traceId?: string;
  parentTraceId?: string;
  warnings?: readonly string[];
  fallback?: boolean;
  synchronization?: string;
  synchronizationEvidence?: unknown;
  cleanup?: unknown;
  error?: StructuredToolError;
}

/**
 * Add the common MCP structured contract while preserving every legacy content
 * block. A final JSON text block mirrors `structuredContent` for clients that
 * do not yet read the structured field; existing first-block consumers remain
 * compatible during the migration window.
 */
export function withStructuredToolResult(
  response: ToolResponse,
  context: ToolResultContext,
): ToolResponse {
  const isError = response.isError === true;
  const structured: StructuredToolContent = {
    ok: !isError,
    ...(!isError ? { data: extractLegacyData(response) } : {}),
    meta: {
      advertisedTool: context.advertisedTool,
      effectiveTool: context.effectiveTool,
      ...(context.backend ? { backend: context.backend } : {}),
      ...(context.projectPath ? { projectPath: context.projectPath } : {}),
      effectScope: context.effectScope,
      ...(context.privilegeGroup ? { privilegeGroup: context.privilegeGroup } : {}),
      ...(context.traceId ? { traceId: context.traceId } : {}),
      ...(context.parentTraceId ? { parentTraceId: context.parentTraceId } : {}),
      durationMs: Math.max(0, Date.now() - context.startedAt),
      warnings: [...(context.warnings ?? [])].slice(0, 32).map(warning => warning.slice(0, 1_024)),
      ...(context.fallback === undefined ? {} : { fallback: context.fallback }),
      ...(context.synchronization === undefined ? {} : { synchronization: context.synchronization }),
      ...(context.synchronizationEvidence === undefined
        ? {}
        : { synchronizationEvidence: boundedDetails(context.synchronizationEvidence) }),
      ...(context.cleanup === undefined ? {} : { cleanup: context.cleanup }),
    },
    ...(isError ? { error: boundedError(context.error ?? legacyError(response)) } : {}),
  };
  const definition = toolDefinitions.find(tool => tool.name === context.advertisedTool)
    ?? toolDefinitions.find(tool => tool.name === context.effectiveTool);
  if (!definition?.outputSchema) throw new Error(`No output schema registered for ${context.advertisedTool}`);
  const issues = validateAgainstSchema(definition.outputSchema, structured);
  if (issues.length > 0) {
    throw new Error(`Invalid structured output for ${context.advertisedTool}: ${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`);
  }
  const commonIssues = validateAgainstSchema(COMMON_STRUCTURED_RESULT_SCHEMA, structured);
  if (commonIssues.length > 0) {
    throw new Error(`Invalid common structured output for ${context.advertisedTool}: ${commonIssues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`);
  }
  const serialized = JSON.stringify(structured, null, 2);
  return {
    ...response,
    content: [...response.content, { type: 'text', text: serialized }],
    structuredContent: structured,
  };
}

function boundedError(error: StructuredToolError): StructuredToolError {
  return {
    code: error.code.slice(0, 128),
    category: error.category,
    message: error.message.slice(0, 4_096),
    ...(error.field === undefined ? {} : { field: error.field.slice(0, 1_024) }),
    retryable: error.retryable,
    remediation: error.remediation.slice(0, 4_096),
    ...(error.details === undefined ? {} : { details: boundedDetails(error.details) }),
  };
}

function boundedDetails(value: unknown, depth = 0): unknown {
  if (depth >= 6) return '[truncated: depth limit]';
  if (typeof value === 'string') return value.slice(0, 2_048);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 32).map(item => boundedDetails(item, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 64).map(([key, item]) => [
    key,
    /token|secret|password|credential|auth|api.?key|private.?key/i.test(key)
      ? '[redacted]'
      : boundedDetails(item, depth + 1),
  ]));
}

export function argumentToolError(
  message: string,
  field: string | undefined,
  details: unknown,
): StructuredToolError {
  return {
    code: 'invalid_arguments',
    category: 'argument',
    message,
    ...(field ? { field } : {}),
    retryable: true,
    remediation: field
      ? `Correct ${field} using the advertised input schema, then retry.`
      : 'Correct the arguments using the advertised input schema, then retry.',
    details,
  };
}

function extractLegacyData(response: ToolResponse): unknown {
  const text = response.content.find(item => item.type === 'text' && typeof item.text === 'string')?.text;
  if (typeof text !== 'string') return { contentTypes: response.content.map(item => item.type) };
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function legacyError(response: ToolResponse): StructuredToolError {
  const text = response.content
    .filter(item => item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text as string)
    .join('\n')
    .slice(0, 4_096) || 'The tool reported an error.';
  return {
    code: 'tool_failed',
    category: 'engine',
    message: text,
    retryable: false,
    remediation: 'Inspect the error, project state, and tool description before retrying.',
  };
}
