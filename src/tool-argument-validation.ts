import type { ToolDefinition } from './tool-definitions.js';
import type { ToolArguments } from './utils.js';

/** Thrown when a tool call does not match its advertised input schema. */
export class ToolArgumentValidationError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly issues: readonly string[],
  ) {
    super(`Invalid arguments for ${toolName}: ${issues.join('; ')}`);
    this.name = 'ToolArgumentValidationError';
  }
}

/**
 * Parses untrusted MCP arguments using the same schema advertised in list_tools.
 * The supported JSON Schema subset intentionally matches the project tool
 * definitions: object properties, required fields, primitive types, enums,
 * string patterns, numeric/array bounds, and homogeneous arrays. Objects
 * without declared properties remain free-form so tools such as `properties`
 * can carry Godot values.
 */
export function parseToolArguments(
  tool: ToolDefinition,
  value: unknown,
): ToolArguments {
  const issues: string[] = [];
  validate(value ?? {}, tool.inputSchema, 'arguments', issues, true);
  if (issues.length > 0) {
    throw new ToolArgumentValidationError(tool.name, issues);
  }
  return value as ToolArguments;
}

export function createToolArgumentParser(
  definitions: readonly ToolDefinition[],
): (name: string, value: unknown) => ToolArguments {
  const definitionsByName = new Map(definitions.map(definition => [definition.name, definition]));
  return (name, value) => {
    const definition = definitionsByName.get(name);
    if (!definition) throw new Error(`No input schema registered for tool: ${name}`);
    return parseToolArguments(definition, value);
  };
}

function validate(
  value: unknown,
  schema: ToolDefinition['inputSchema'],
  path: string,
  issues: string[],
  rejectUnknownProperties = false,
): void {
  if (schema.oneOf) {
    const matchingBranches = schema.oneOf.filter(branch => {
      const branchIssues: string[] = [];
      validate(value, branch, path, branchIssues);
      return branchIssues.length === 0;
    });
    if (matchingBranches.length !== 1) issues.push(`${path} must match exactly one allowed schema`);
    return;
  }
  if (!matchesType(value, schema.type)) {
    issues.push(`${path} must be ${schema.type}`);
    return;
  }

  if (schema.enum && !schema.enum.includes(value as never)) {
    issues.push(`${path} must be one of: ${schema.enum.join(', ')}`);
  }

  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    issues.push(`${path} must match: ${schema.pattern}`);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push(`${path} must contain at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push(`${path} must contain at most ${schema.maxLength} characters`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push(`${path} must be at least ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push(`${path} must be at most ${schema.maximum}`);
    }
  }

  if (schema.type === 'object' && isRecord(value)) {
    const properties = schema.properties;
    for (const required of schema.required ?? []) {
      if (!(required in value)) issues.push(`${path}.${required} is required`);
    }
    if (properties) {
      for (const [key, propertyValue] of Object.entries(value)) {
        const propertySchema = properties[key];
        if (!propertySchema) {
          if (rejectUnknownProperties) issues.push(`${path}.${key} is not allowed`);
          continue;
        }
        validate(propertyValue, propertySchema, `${path}.${key}`, issues);
      }
    }
  }

  if (schema.type === 'array' && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push(`${path} must contain at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push(`${path} must contain at most ${schema.maxItems} items`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        validate(item, schema.items!, `${path}[${index}]`, issues);
      });
    }
  }
}

function matchesType(value: unknown, type: ToolDefinition['inputSchema']['type']): boolean {
  if (!type) return true;
  switch (type) {
    case 'object': return isRecord(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
