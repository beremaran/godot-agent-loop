import type { ToolPropertySchema } from './tool-definitions.js';

const JSON_SCHEMA_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

/**
 * Concise, closed result envelope for the compact/core advertisement. It keeps
 * the same wire-compatible success/error contract without repeating the full
 * field documentation and examples on every advertised core tool.
 */
export const COMPACT_STRUCTURED_RESULT_SCHEMA: ToolPropertySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    data: {},
    meta: { type: 'object' },
    error: { type: 'object' },
  },
  required: ['ok', 'meta'],
  oneOf: [
    {
      properties: { ok: { const: true } },
      required: ['data'],
      not: { required: ['error'] },
    },
    {
      properties: { ok: { const: false } },
      required: ['error'],
      not: { required: ['data'] },
    },
  ],
};

/** Shared MCP output contract advertised by every tool definition. */
export const COMMON_STRUCTURED_RESULT_SCHEMA: ToolPropertySchema = {
  $schema: JSON_SCHEMA_2020_12,
  type: 'object',
  description: 'Structured Godot tool result with typed metadata and mutually exclusive success or error payloads.',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'True for success and false for a recoverable tool error.' },
    data: { description: 'Tool-specific JSON-safe success data; binary content remains in MCP content blocks.' },
    meta: {
      type: 'object',
      description: 'Common execution, correlation, effect, warning, fallback, synchronization, and cleanup metadata.',
      additionalProperties: false,
      properties: {
        advertisedTool: { type: 'string', description: 'Tool identity invoked by the client.' },
        effectiveTool: { type: 'string', description: 'Actual capability executed after dispatcher resolution.' },
        backend: { type: 'string', description: 'Effective execution backend, including file-backed/editor fallback detail when available.' },
        projectPath: { type: 'string', description: 'Resolved project path when the call is project-correlated.' },
        effectScope: {
          type: 'string',
          enum: ['read-only', 'project-persistent', 'runtime-ephemeral', 'process', 'external-open-world'],
          description: 'Effective operation scope used by policy and human-facing activity.',
        },
        privilegeGroup: { type: 'string', description: 'Effective privilege group when elevated capability is required.' },
        traceId: { type: 'string', description: 'Correlation identifier for this effective call.' },
        parentTraceId: { type: 'string', description: 'Parent correlation identifier for dispatched or scenario child calls.' },
        durationMs: { type: 'number', minimum: 0, description: 'Server-observed duration in milliseconds.' },
        warnings: {
          type: 'array', maxItems: 32, description: 'Bounded non-fatal warnings.',
          items: { type: 'string', maxLength: 1024, description: 'One bounded warning.' },
        },
        fallback: { type: 'boolean', description: 'Whether a disclosed fallback path was used.' },
        synchronization: { type: 'string', description: 'Editor or persistence synchronization status when applicable.' },
        synchronizationEvidence: {
          type: 'object', additionalProperties: true,
          description: 'Bounded editor acknowledgement, fallback, or conflict evidence when persistence synchronization was attempted.',
        },
        cleanup: { description: 'Typed cleanup state when the tool owns transient state.' },
      },
      required: ['advertisedTool', 'effectiveTool', 'effectScope', 'durationMs', 'warnings'],
      examples: [{
        advertisedTool: 'godot_catalog', effectiveTool: 'godot_catalog', effectScope: 'read-only',
        traceId: 'trace-1', durationMs: 2, warnings: [],
      }],
    },
    error: {
      type: 'object',
      description: 'Stable, model-recoverable tool error contract.',
      additionalProperties: false,
      properties: {
        code: { type: 'string', maxLength: 128, description: 'Stable machine-readable error code.' },
        category: {
          type: 'string',
          enum: ['argument', 'policy', 'precondition', 'engine', 'timeout', 'cancelled', 'conflict', 'internal'],
          description: 'Stable error category used for recovery and display.',
        },
        message: { type: 'string', maxLength: 4096, description: 'Bounded human-readable error message.' },
        field: { type: 'string', maxLength: 1024, description: 'Argument field path or engine location when known.' },
        retryable: { type: 'boolean', description: 'Whether retrying after remediation can reasonably succeed.' },
        remediation: { type: 'string', maxLength: 4096, description: 'Concrete next step for recovery.' },
        details: { description: 'Bounded structured diagnostics with credential-like fields redacted.' },
      },
      required: ['code', 'category', 'message', 'retryable', 'remediation'],
      examples: [{
        code: 'invalid_arguments', category: 'argument', message: 'arguments.x must be number',
        field: 'arguments.x', retryable: true, remediation: 'Correct arguments.x and retry.',
      }],
    },
  },
  required: ['ok', 'meta'],
  oneOf: [
    {
      type: 'object',
      description: 'Successful result with tool-specific data and no error object.',
      properties: { ok: { const: true, description: 'Success discriminator.' } },
      required: ['ok', 'data'],
      not: { required: ['error'], description: 'A successful result cannot contain an error.' },
    },
    {
      type: 'object',
      description: 'Recoverable tool error with no success data.',
      properties: { ok: { const: false, description: 'Error discriminator.' } },
      required: ['ok', 'error'],
      not: { required: ['data'], description: 'An error result cannot contain success data.' },
    },
  ],
  examples: [{
    ok: true,
    data: { results: [] },
    meta: {
      advertisedTool: 'godot_catalog', effectiveTool: 'godot_catalog', effectScope: 'read-only',
      durationMs: 2, warnings: [],
    },
  }],
};

const DISTINCT_OUTPUT_DATA_SCHEMAS: Readonly<Record<string, ToolPropertySchema>> = {
  godot_catalog: {
    type: 'object', additionalProperties: true,
    description: 'Catalog search results or one described tool record.', examples: [{ results: [], count: 0 }],
  },
  game_wait_until: {
    type: 'object', additionalProperties: false,
    description: 'Bounded wait evidence.',
    properties: {
      satisfied: { type: 'boolean' }, condition: {}, elapsed_ms: { type: 'number', minimum: 0 },
      attempts: { type: 'integer', minimum: 0 }, last_observed: {}, error: { type: 'string' },
    },
    required: ['satisfied'], examples: [{ satisfied: true, condition: 'connection', elapsed_ms: 2, attempts: 1, last_observed: true }],
  },
  game_scenario: {
    type: 'object', additionalProperties: false,
    description: 'Scenario outcome, bounded child evidence, and cleanup state.',
    properties: {
      name: { type: 'string' }, passed: { type: 'boolean' }, failure: {},
      step_count: { type: 'integer', minimum: 0 }, duration_ms: { type: 'number', minimum: 0 },
      steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
      teardown: { type: 'object', additionalProperties: true },
    },
    required: ['name', 'passed', 'step_count', 'duration_ms', 'steps', 'teardown'],
    examples: [{ name: 'smoke', passed: true, failure: null, step_count: 0, duration_ms: 1, steps: [], teardown: { attempted: true } }],
  },
  game_screenshot: {
    type: 'object', additionalProperties: false,
    description: 'Typed metadata for preserved screenshot content blocks.',
    properties: {
      contentTypes: { type: 'array', items: { type: 'string' } }, captured: { type: 'boolean' },
      bytes: { type: 'integer', minimum: 0 }, sha256: { type: 'string' }, artifact_path: {},
      width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 },
      project_artifact: { type: 'boolean' }, visual_regression_metadata: {},
    },
    examples: [{ contentTypes: ['image'] }],
  },
};

/** Detailed per-tool result contract used by full/catalog advertisement and runtime validation. */
export function structuredResultSchemaFor(toolName: string): ToolPropertySchema {
  const data = DISTINCT_OUTPUT_DATA_SCHEMAS[toolName];
  if (!data) return COMMON_STRUCTURED_RESULT_SCHEMA;
  return {
    ...COMMON_STRUCTURED_RESULT_SCHEMA,
    properties: { ...COMMON_STRUCTURED_RESULT_SCHEMA.properties, data },
  };
}
