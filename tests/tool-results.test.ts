// @test-kind: unit
import { describe, expect, it } from 'vitest';

import { toolDefinitions } from '../src/tool-definitions.js';
import { validateAgainstSchema } from '../src/tool-argument-validation.js';
import { advertisedToolDefinitions } from '../src/tool-surface.js';
import {
  argumentToolError,
  COMMON_STRUCTURED_RESULT_SCHEMA,
  withStructuredToolResult,
} from '../src/tool-results.js';

describe('structured tool results', () => {
  it('preserves legacy blocks and adds schema-valid structured success content', () => {
    const response = withStructuredToolResult({
      content: [{ type: 'text', text: JSON.stringify({ connected: true }) }],
    }, {
      advertisedTool: 'editor_session', effectiveTool: 'editor_session',
      effectScope: 'read-only', projectPath: '/project', startedAt: Date.now(), traceId: 'trace-1',
    });
    expect(response.content[0]).toEqual({ type: 'text', text: JSON.stringify({ connected: true }) });
    expect(response.structuredContent).toMatchObject({
      ok: true,
      data: { connected: true },
      meta: { advertisedTool: 'editor_session', effectiveTool: 'editor_session', traceId: 'trace-1' },
    });
  });

  it('emits stable recoverable error details and equivalent JSON text', () => {
    const error = argumentToolError('arguments.x must be number', 'arguments.x', [{ keyword: 'type' }]);
    const response = withStructuredToolResult({
      content: [{ type: 'text', text: error.message }], isError: true,
    }, {
      advertisedTool: 'game_click', effectiveTool: 'game_click', effectScope: 'runtime-ephemeral',
      privilegeGroup: 'reflection', startedAt: Date.now(), error,
    });
    expect(response.structuredContent).toMatchObject({
      ok: false,
      meta: { privilegeGroup: 'reflection' },
      error: { code: 'invalid_arguments' },
    });
    expect(JSON.parse(response.content.at(-1)?.text as string)).toEqual(response.structuredContent);
  });

  it('validates structured success and error envelopes for every advertised output schema', () => {
    const compactOutputSchemas = new Map(advertisedToolDefinitions('core').map(
      definition => [definition.name, definition.outputSchema],
    ));
    for (const definition of toolDefinitions) {
      const successData = definition.name === 'godot_catalog' ? { results: [], count: 0 }
        : definition.name === 'game_wait_until' ? { satisfied: true }
          : definition.name === 'game_scenario' ? {
              name: 'smoke', passed: true, failure: null, step_count: 0,
              duration_ms: 1, steps: [], teardown: { attempted: true },
            }
            : definition.name === 'game_screenshot' ? { contentTypes: ['image'] }
              : { tool: definition.name };
      const context = {
        advertisedTool: definition.name,
        effectiveTool: definition.name,
        effectScope: 'read-only' as const,
        startedAt: Date.now(),
      };
      const success = withStructuredToolResult({
        content: [{ type: 'text', text: JSON.stringify(successData) }],
      }, context);
      const failure = withStructuredToolResult({
        content: [{ type: 'text', text: 'failed safely' }], isError: true,
      }, { ...context, error: argumentToolError('Invalid example', 'arguments.value', []) });

      expect(validateAgainstSchema(definition.outputSchema!, success.structuredContent), definition.name)
        .toEqual([]);
      expect(validateAgainstSchema(definition.outputSchema!, failure.structuredContent), definition.name)
        .toEqual([]);
      expect(validateAgainstSchema(COMMON_STRUCTURED_RESULT_SCHEMA, success.structuredContent), definition.name)
        .toEqual([]);
      expect(validateAgainstSchema(COMMON_STRUCTURED_RESULT_SCHEMA, failure.structuredContent), definition.name)
        .toEqual([]);
      const compactOutputSchema = compactOutputSchemas.get(definition.name);
      if (compactOutputSchema) {
        expect(validateAgainstSchema(compactOutputSchema, success.structuredContent), definition.name).toEqual([]);
        expect(validateAgainstSchema(compactOutputSchema, failure.structuredContent), definition.name).toEqual([]);
      }
      expect(JSON.parse(success.content.at(-1)?.text as string)).toEqual(success.structuredContent);
      expect(JSON.parse(failure.content.at(-1)?.text as string)).toEqual(failure.structuredContent);
    }
  });

  it('rejects contradictory success and error envelopes in the common contract', () => {
    const meta = {
      advertisedTool: 'game_click', effectiveTool: 'game_click', effectScope: 'runtime-ephemeral',
      durationMs: 1, warnings: [],
    };
    expect(validateAgainstSchema(COMMON_STRUCTURED_RESULT_SCHEMA, { ok: true, data: {}, meta }))
      .toEqual([]);
    expect(validateAgainstSchema(COMMON_STRUCTURED_RESULT_SCHEMA, {
      ok: false, meta, error: argumentToolError('bad', 'arguments.x', []),
    })).toEqual([]);
    expect(validateAgainstSchema(COMMON_STRUCTURED_RESULT_SCHEMA, {
      ok: true, data: {}, meta, error: argumentToolError('bad', 'arguments.x', []),
    })).toEqual(expect.arrayContaining([expect.objectContaining({ keyword: 'oneOf' })]));
    expect(validateAgainstSchema(COMMON_STRUCTURED_RESULT_SCHEMA, { ok: false, meta }))
      .not.toEqual([]);
  });

  it('preserves image, audio, and resource blocks for older clients and types them in structured metadata', () => {
    const legacyBlocks = [
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      { type: 'audio', data: 'aGVsbG8=', mimeType: 'audio/wav' },
      { type: 'resource', resource: { uri: 'res://evidence.json', text: '{}' } },
    ];
    const response = withStructuredToolResult({ content: legacyBlocks }, {
      advertisedTool: 'game_screenshot', effectiveTool: 'game_screenshot',
      effectScope: 'read-only', startedAt: Date.now(),
    });

    expect(response.content.slice(0, legacyBlocks.length)).toEqual(legacyBlocks);
    expect(response.structuredContent).toMatchObject({
      ok: true,
      data: { contentTypes: ['image', 'audio', 'resource'] },
    });
    expect(JSON.parse(response.content.at(-1)?.text as string)).toEqual(response.structuredContent);
  });

  it('bounds warnings and error details while redacting credential-like fields', () => {
    const response = withStructuredToolResult({
      content: [{ type: 'text', text: 'failure' }], isError: true,
    }, {
      advertisedTool: 'godot_call', effectiveTool: 'game_http_request',
      effectScope: 'external-open-world', startedAt: Date.now(),
      warnings: Array.from({ length: 40 }, () => 'w'.repeat(2_000)),
      error: {
        code: 'x'.repeat(200), category: 'engine', message: 'm'.repeat(8_000),
        retryable: false, remediation: 'r'.repeat(8_000),
        details: {
          authToken: 'do-not-expose',
          values: Array.from({ length: 100 }, (_, index) => index),
          nested: { a: { b: { c: { d: { e: { f: 'too-deep' } } } } } },
        },
      },
    });
    const structured = response.structuredContent as {
      meta: { warnings: string[] };
      error: { code: string; message: string; remediation: string; details: Record<string, unknown> };
    };

    expect(structured.meta.warnings).toHaveLength(32);
    expect(structured.meta.warnings.every(warning => warning.length === 1_024)).toBe(true);
    expect(structured.error.code).toHaveLength(128);
    expect(structured.error.message).toHaveLength(4_096);
    expect(structured.error.remediation).toHaveLength(4_096);
    expect(structured.error.details.authToken).toBe('[redacted]');
    expect(structured.error.details.values).toHaveLength(32);
    expect(JSON.stringify(structured.error.details)).not.toContain('too-deep');
  });
});
