import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import formatsPlugin from 'ajv-formats';

import type { ToolDefinition, ToolPropertySchema } from './tool-definitions.js';
import { normalizeParameters, type ToolArguments } from './utils.js';

export interface ToolArgumentIssue {
  path: string;
  keyword: string;
  message: string;
  params: Record<string, unknown>;
}

/** Thrown when a tool call does not match its advertised input schema. */
export class ToolArgumentValidationError extends Error {
  public readonly issues: readonly string[];

  constructor(
    public readonly toolName: string,
    public readonly details: readonly ToolArgumentIssue[],
  ) {
    const issues = details.map(issue => `${issue.path} ${issue.message}`.trim());
    super(`Invalid arguments for ${toolName}: ${issues.join('; ')}`);
    this.name = 'ToolArgumentValidationError';
    this.issues = issues;
  }
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  validateFormats: true,
  allowUnionTypes: true,
});
const addFormats = formatsPlugin as unknown as (instance: Ajv2020) => Ajv2020;
addFormats(ajv);

/**
 * Parses untrusted MCP arguments with a standards-compliant JSON Schema
 * 2020-12 validator. The same schema objects are returned by tools/list, so a
 * client and the server observe identical structural requirements.
 */
export function parseToolArguments(
  tool: ToolDefinition,
  value: unknown,
): ToolArguments {
  const validate = validatorFor(tool);
  const input = normalizeInput(value);
  if (!validate(input)) {
    throw new ToolArgumentValidationError(tool.name, relevantIssues(tool.inputSchema, input, validate.errors ?? []));
  }
  return input as ToolArguments;
}

export function createToolArgumentParser(
  definitions: readonly ToolDefinition[],
): (name: string, value: unknown) => ToolArguments {
  const validators = new Map<string, ValidateFunction>();
  const definitionsByName = new Map(definitions.map(definition => [definition.name, definition]));
  for (const definition of definitions) {
    validators.set(definition.name, ajv.compile(definition.inputSchema as Record<string, unknown>));
  }
  return (name, value) => {
    const definition = definitionsByName.get(name);
    const validate = validators.get(name);
    if (!definition || !validate) throw new Error(`No input schema registered for tool: ${name}`);
    const input = normalizeInput(value);
    if (!validate(input)) {
      throw new ToolArgumentValidationError(name, relevantIssues(definition.inputSchema, input, validate.errors ?? []));
    }
    return input as ToolArguments;
  };
}

function normalizeInput(value: unknown): unknown {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return value;
  return normalizeParameters(value as ToolArguments);
}

/** Compile every public schema; useful for deterministic build/quality gates. */
export function compileToolSchemas(definitions: readonly ToolDefinition[]): void {
  for (const definition of definitions) {
    ajv.compile(definition.inputSchema as Record<string, unknown>);
    if (definition.outputSchema) ajv.compile(definition.outputSchema as Record<string, unknown>);
  }
}

/** Validate arbitrary content against a public tool schema in tests/adapters. */
export function validateAgainstSchema(
  schema: ToolPropertySchema,
  value: unknown,
): readonly ToolArgumentIssue[] {
  let validate = schemaValidatorCache.get(schema);
  if (!validate) {
    validate = ajv.compile(schema as Record<string, unknown>);
    schemaValidatorCache.set(schema, validate);
  }
  return validate(value) ? [] : relevantIssues(schema, value, validate.errors ?? []);
}

const validatorCache = new WeakMap<ToolDefinition, ValidateFunction>();
const schemaValidatorCache = new WeakMap<ToolPropertySchema, ValidateFunction>();

function validatorFor(tool: ToolDefinition): ValidateFunction {
  const cached = validatorCache.get(tool);
  if (cached) return cached;
  const validate = ajv.compile(tool.inputSchema as Record<string, unknown>);
  validatorCache.set(tool, validate);
  return validate;
}

/**
 * AJV reports every rejected top-level action branch for `oneOf`. Once the
 * action discriminator itself is valid, only the selected branch is useful to
 * a caller; errors from the other actions otherwise obscure the actual missing
 * or invalid field and produce misleading remediation.
 */
function relevantIssues(
  schema: ToolPropertySchema,
  input: unknown,
  errors: readonly ErrorObject[],
): ToolArgumentIssue[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return errors.map(formatIssue);
  const record = input as Record<string, unknown>;
  let filtered = errors;
  if (typeof record.action === 'string'
    && schema.oneOf?.some(branch => branch.properties?.action?.const !== undefined)) {
    const selected = schema.oneOf.findIndex(branch => branch.properties?.action?.const === record.action);
    const branchPattern = /^#\/oneOf\/(\d+)(?:\/|$)/;
    filtered = filtered.filter(error => {
      const match = branchPattern.exec(error.schemaPath);
      if (!match) return !(error.keyword === 'oneOf' && error.schemaPath === '#/oneOf');
      return selected >= 0 && Number(match[1]) === selected;
    });
  }
  const stepBranches = schema.properties?.steps?.items?.oneOf;
  if (Array.isArray(record.steps) && stepBranches?.some(branch => branch.properties?.type?.const !== undefined)) {
    const steps = record.steps;
    const branchPattern = /^#\/properties\/steps\/items\/oneOf\/(\d+)(?:\/|$)/;
    filtered = filtered.filter(error => {
      const stepMatch = /^\/steps\/(\d+)(?:\/|$)/.exec(error.instancePath);
      if (!stepMatch) return true;
      const step = steps[Number(stepMatch[1])];
      if (!step || typeof step !== 'object' || Array.isArray(step)) return true;
      const selected = stepBranches.findIndex(
        branch => branch.properties?.type?.const === (step as Record<string, unknown>).type,
      );
      if (selected < 0) return true;
      const branchMatch = branchPattern.exec(error.schemaPath);
      if (branchMatch) return Number(branchMatch[1]) === selected;
      return !(error.keyword === 'oneOf'
        && error.schemaPath === '#/properties/steps/items/oneOf');
    });
  }
  return (filtered.length > 0 ? filtered : errors).map(formatIssue);
}

function formatIssue(error: ErrorObject): ToolArgumentIssue {
  let pointer = error.instancePath;
  if (error.keyword === 'required' && typeof error.params.missingProperty === 'string') {
    pointer = `${pointer}/${escapePointer(error.params.missingProperty)}`;
  } else if (error.keyword === 'additionalProperties'
    && typeof error.params.additionalProperty === 'string') {
    pointer = `${pointer}/${escapePointer(error.params.additionalProperty)}`;
  }
  const path = pointer.length === 0
    ? 'arguments'
    : `arguments${pointer.split('/').slice(1).map(pointerPart).join('')}`;
  return {
    path,
    keyword: error.keyword,
    message: friendlyMessage(error),
    params: { ...error.params },
  };
}

function friendlyMessage(error: ErrorObject): string {
  if (error.keyword === 'additionalProperties') return 'is not allowed';
  if (error.keyword === 'required') return 'is required';
  if (error.keyword === 'type' && typeof error.params.type === 'string') {
    return `must be ${error.params.type}`;
  }
  if (error.keyword === 'enum' && Array.isArray(error.params.allowedValues)) {
    return `must be one of: ${error.params.allowedValues.join(', ')}`;
  }
  if (error.keyword === 'minimum') return `must be at least ${String(error.params.limit)}`;
  if (error.keyword === 'maximum') return `must be at most ${String(error.params.limit)}`;
  if (error.keyword === 'maxItems') return `must contain at most ${String(error.params.limit)} items`;
  if (error.keyword === 'minItems') return `must contain at least ${String(error.params.limit)} items`;
  if (error.keyword === 'maxLength') return `must contain at most ${String(error.params.limit)} characters`;
  if (error.keyword === 'minLength') return `must contain at least ${String(error.params.limit)} characters`;
  if (error.keyword === 'pattern') return `must match: ${String(error.params.pattern)}`;
  if (error.keyword === 'oneOf') return 'must match exactly one allowed schema';
  if (error.keyword === 'not') return 'is forbidden by this action shape';
  return error.message ?? `failed ${error.keyword} validation`;
}

function escapePointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function pointerPart(value: string): string {
  const decoded = value.replace(/~1/g, '/').replace(/~0/g, '~');
  return /^\d+$/.test(decoded) ? `[${decoded}]` : `.${decoded}`;
}
