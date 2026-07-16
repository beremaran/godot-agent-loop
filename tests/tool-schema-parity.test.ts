// @test-kind: contract
import { describe, expect, it } from 'vitest';
import {
  toolDefinitions,
  type ToolPropertySchema,
  type ToolSchemaInvalidExample,
} from '../src/tool-definitions.js';
import { toolManifest } from '../src/tool-manifest.js';
import {
  compileToolSchemas,
  parseToolArguments,
  ToolArgumentValidationError,
  validateAgainstSchema,
} from '../src/tool-argument-validation.js';
import { normalizeParameters } from '../src/utils.js';

function sampleValue(schema: ToolPropertySchema, requestedAction?: string): unknown {
  if (schema.const !== undefined) return schema.const;
  if (schema.examples && schema.examples.length > 0) return schema.examples[0];
  if (requestedAction !== undefined && schema.enum?.includes(requestedAction)) return requestedAction;
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];
  if (schema.type === 'object') return sampleObject(schema, requestedAction);
  if (schema.oneOf && schema.oneOf.length > 0) return sampleValue(schema.oneOf[0], requestedAction);
  if (schema.anyOf && schema.anyOf.length > 0) return sampleValue(schema.anyOf[0], requestedAction);
  if (schema.type === 'boolean') return true;
  if (schema.type === 'integer' || schema.type === 'number') return schema.minimum ?? 1;
  if (schema.type === 'array') {
    const length = Math.max(0, schema.minItems ?? 0);
    return Array.from({ length }, () => sampleValue(schema.items ?? {}));
  }
  if (schema.type === 'string') {
    if (schema.pattern?.includes('https?://')) return 'http://127.0.0.1';
    if (schema.pattern?.includes('a-fA-F0-9') && schema.pattern.includes('{64}')) return '0'.repeat(64);
    return 'value';
  }
  return null;
}

function selectedBranch(schema: ToolPropertySchema, requestedAction?: string): ToolPropertySchema | undefined {
  if (!schema.oneOf || schema.oneOf.length === 0) return undefined;
  if (requestedAction === undefined) return schema.oneOf[0];
  return schema.oneOf.find(branch => branch.properties?.action?.const === requestedAction)
    ?? schema.oneOf[0];
}

function sampleObject(schema: ToolPropertySchema, requestedAction?: string): Record<string, unknown> {
  const branch = selectedBranch(schema, requestedAction);
  const required = new Set([...(schema.required ?? []), ...(branch?.required ?? [])]);
  const properties = { ...(schema.properties ?? {}), ...(branch?.properties ?? {}) };
  const result: Record<string, unknown> = {};
  for (const name of required) {
    const property = properties[name] ?? {};
    result[name] = name === 'action' && requestedAction !== undefined
      ? requestedAction
      : sampleValue(property);
  }
  return result;
}

function runtimeIssues(tool: typeof toolDefinitions[number], value: unknown) {
  try {
    parseToolArguments(tool, value);
    return [];
  } catch (error) {
    if (error instanceof ToolArgumentValidationError) return error.details;
    throw error;
  }
}

describe('advertised and runtime schema parity', () => {
  it('compiles every complete-catalog input and output schema as JSON Schema 2020-12', () => {
    expect(() => {
      compileToolSchemas(toolDefinitions);
    }).not.toThrow();
  });

  it('uses the manifest action inventory as every mode discriminator enum', () => {
    for (const definition of toolDefinitions) {
      const actions = toolManifest[definition.name].actions;
      if (!actions) continue;
      expect([...(definition.inputSchema.properties?.action?.enum ?? [])].sort(), definition.name)
        .toEqual([...actions].sort());
    }
  });

  it('commits and validates complex-object and action-family examples', () => {
    const visit = (schema: ToolPropertySchema, path: string): void => {
      if (schema.type === 'object' || schema.type === 'array') {
        expect(schema.examples?.length, `${path}.examples`).toBeGreaterThan(0);
        for (const example of schema.examples ?? []) {
          expect(validateAgainstSchema(schema, example), `${path}: ${JSON.stringify(example)}`).toEqual([]);
        }
      }
      for (const [name, property] of Object.entries(schema.properties ?? {})) visit(property, `${path}.${name}`);
      if (schema.items) visit(schema.items, `${path}[]`);
      for (const [keyword, branches] of [
        ['oneOf', schema.oneOf], ['anyOf', schema.anyOf], ['allOf', schema.allOf],
      ] as const) branches?.forEach((branch, index) => {
        visit(branch, `${path}.${keyword}[${index}]`);
      });
    };

    for (const definition of toolDefinitions) {
      const actions = toolManifest[definition.name].actions;
      expect(definition.inputSchema.examples).toHaveLength(actions?.length ?? 1);
      if (actions) {
        expect(definition.inputSchema.examples?.map(example => (example as Record<string, unknown>).action))
          .toEqual(actions);
      }
      visit(definition.inputSchema, definition.name);
    }
  });

  it('commits negative examples that fail at their declared field and keyword', () => {
    for (const definition of toolDefinitions) {
      const invalid: readonly ToolSchemaInvalidExample[] = definition.inputSchema['x-invalidExamples']!;
      const actions = toolManifest[definition.name].actions;
      expect(invalid, definition.name).toHaveLength(actions ? actions.length + 1 : 1);
      if (actions) expect(invalid.slice(1).map(example => example.action)).toEqual(actions);
      for (const example of invalid) {
        const issues = validateAgainstSchema(definition.inputSchema, example.value);
        expect(issues, `${definition.name}: ${JSON.stringify(example.value)}`).toEqual(expect.arrayContaining([
          expect.objectContaining({ path: example.path, keyword: example.keyword }),
        ]));
        expect(runtimeIssues(definition, example.value)).toEqual(issues);
      }
    }
  });

  it('accepts the same generated positive corpus through advertised and runtime validators', () => {
    for (const definition of toolDefinitions) {
      const actions = toolManifest[definition.name].actions;
      const samples = actions?.map(action => sampleObject(definition.inputSchema, action))
        ?? [sampleObject(definition.inputSchema)];
      for (const sample of samples) {
        const normalized = normalizeParameters(sample);
        expect(validateAgainstSchema(definition.inputSchema, normalized), `${definition.name}: ${JSON.stringify(normalized)}`)
          .toEqual([]);
        expect(runtimeIssues(definition, sample), definition.name).toEqual([]);
      }
    }
  });

  it('rejects the same unknown fields and invalid actions at the intended field path', () => {
    for (const definition of toolDefinitions) {
      const sample = sampleObject(definition.inputSchema);
      const unknown = { ...sample, unexpected: true };
      expect(runtimeIssues(definition, unknown))
        .toEqual(validateAgainstSchema(definition.inputSchema, normalizeParameters(unknown)));
      expect(runtimeIssues(definition, unknown)).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'arguments.unexpected', keyword: 'additionalProperties' }),
      ]));

      const actions = toolManifest[definition.name].actions;
      if (!actions) continue;
      const invalidAction = { ...sampleObject(definition.inputSchema, actions[0]), action: '__invalid__' };
      const advertised = validateAgainstSchema(definition.inputSchema, normalizeParameters(invalidAction));
      expect(runtimeIssues(definition, invalidAction)).toEqual(advertised);
      expect(advertised).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'arguments.action', keyword: 'enum' }),
      ]));
    }
  });
});
