// @test-kind: e2e
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolPropertySchema } from '../../src/tool-definitions.js';
import { toolDefinitions } from '../../src/tool-definitions.js';
import { validateAgainstSchema } from '../../src/tool-argument-validation.js';
import { toolManifest } from '../../src/tool-manifest.js';
import { startServer, type E2EServer } from './helpers/harness.js';

let server: E2EServer | null = null;

afterEach(async () => {
  if (server) {
    const active = server;
    server = null;
    await active.close();
  }
});

function representative(schema: ToolPropertySchema): unknown {
  if (schema.oneOf) return representative(schema.oneOf[0]);
  if (schema.enum?.length) return schema.enum[0];
  switch (schema.type) {
    case 'string': {
      if (schema.pattern?.startsWith('^https?://')) return 'http://127.0.0.1';
      if (schema.pattern?.startsWith('^4\\.')) return '4.7-stable';
      return 'x'.repeat(Math.max(1, schema.minLength ?? 1));
    }
    case 'integer': return Math.max(schema.minimum ?? 0, 0);
    case 'number': return Math.max(schema.minimum ?? 0, 0);
    case 'boolean': return false;
    case 'array': return Array.from({ length: Math.max(1, schema.minItems ?? 0) }, () => representative(schema.items ?? {}));
    case 'object': return {
      x: 1, y: 1, z: 1, r: 1, g: 1, b: 1, a: 1,
      origin: { x: 1, y: 1, z: 1 }, size: { x: 1, y: 1, z: 1 },
    };
    default: return null;
  }
}

function wrongType(schema: ToolPropertySchema): unknown {
  if (schema.oneOf) return null;
  switch (schema.type) {
    case 'string': return 42;
    case 'integer': return 1.5;
    case 'number': return 'not-a-number';
    case 'boolean': return 'not-a-boolean';
    case 'array': return {};
    case 'object': return [];
    default: return '__invalid_union__';
  }
}

function representativeParameter(name: string, schema: ToolPropertySchema): unknown {
  if (schema.enum?.length) return schema.enum[0];
  const semanticStrings: Record<string, string> = {
    type: 'Node', className: 'Node', nodeType: 'Node', shapeType: 'box',
    signalName: 'ready', method: 'get_name', property: 'name', csgType: 'box',
    meshType: 'box', effectType: 'decal', giType: 'voxel_gi', jointType: 'pin_2d',
    animationName: 'RESET', group: 'missing_group', key: 'A', actionName: 'ui_accept',
  };
  if (semanticStrings[name]) return semanticStrings[name];
  if (/^(?:node|parent|root|source|target|camera)Path$/.test(name)) return '/root/DefinitelyMissingNode';
  if (name === 'path' || /(?:scene|resource|video|script|file)Path$/.test(name)) {
    return 'res://definitely_missing_resource.tres';
  }
  return representative(schema);
}

async function rejected(name: string, args: Record<string, unknown>, issue: string): Promise<void> {
  const result = await server!.client.callTool({ name, arguments: args });
  expect(result.isError, `${name}.${issue} unexpectedly passed argument validation`).toBe(true);
  const structured = result.structuredContent as {
    ok?: boolean;
    error?: { category?: string; message?: string };
  } | undefined;
  expect(structured, `${name}.${issue} returned no structured error`).toMatchObject({
    ok: false,
    error: { category: 'argument' },
  });
  expect(structured?.error?.message, `${name}.${issue}`).toMatch(/Invalid arguments|not allowed|required|must/i);
}

describe('all advertised tool schemas through the built MCP server', () => {
  it('rejects unknown fields, every missing required field, and every declared constraint', async () => {
    server = await startServer();
    const discovered = await server.client.listTools();
    expect(discovered.tools.map(tool => tool.name).sort())
      .toEqual(toolDefinitions.map(tool => tool.name).sort());

    for (const definition of toolDefinitions) {
      const properties = definition.inputSchema.properties;
      const validRequired = Object.fromEntries(
        (definition.inputSchema.required ?? []).map(name => [name, representativeParameter(name, properties[name])]),
      );
      await rejected(definition.name, { ...validRequired, __unexpected__: true }, 'unknown-field');

      for (const required of definition.inputSchema.required ?? []) {
        const missing = Object.fromEntries(
          Object.entries(validRequired).filter(([name]) => name !== required),
        );
        await rejected(definition.name, missing, `missing-${required}`);
      }

      for (const [parameter, schema] of Object.entries(properties)) {
        if (schema.type !== undefined || schema.oneOf !== undefined) {
          await rejected(definition.name, { ...validRequired, [parameter]: wrongType(schema) }, `${parameter}-type`);
        }
        if (schema.enum) {
          await rejected(definition.name, { ...validRequired, [parameter]: '__outside_enum__' }, `${parameter}-enum`);
        }
        if (schema.minimum !== undefined) {
          await rejected(definition.name, { ...validRequired, [parameter]: schema.minimum - 1 }, `${parameter}-minimum`);
        }
        if (schema.maximum !== undefined) {
          await rejected(definition.name, { ...validRequired, [parameter]: schema.maximum + 1 }, `${parameter}-maximum`);
        }
        if (schema.minLength !== undefined) {
          await rejected(definition.name, { ...validRequired, [parameter]: 'x'.repeat(Math.max(0, schema.minLength - 1)) }, `${parameter}-minLength`);
        }
        if (schema.maxLength !== undefined) {
          await rejected(definition.name, { ...validRequired, [parameter]: 'x'.repeat(schema.maxLength + 1) }, `${parameter}-maxLength`);
        }
        if (schema.minItems !== undefined) {
          await rejected(definition.name, { ...validRequired, [parameter]: [] }, `${parameter}-minItems`);
        }
        if (schema.maxItems !== undefined) {
          await rejected(definition.name, {
            ...validRequired,
            [parameter]: Array.from({ length: schema.maxItems + 1 }, () => representative(schema.items ?? {})),
          }, `${parameter}-maxItems`);
        }
        if (schema.pattern !== undefined) {
          await rejected(definition.name, { ...validRequired, [parameter]: '\n' }, `${parameter}-pattern`);
        }
      }
    }
  });

  it('returns a controlled precondition or lifecycle failure for every runtime-backed tool without a game', async () => {
    server = await startServer();
    for (const definition of toolDefinitions) {
      const backend = toolManifest[definition.name].backend.kind;
      if (backend !== 'runtime' && backend !== 'runtime-buffer') continue;
      const args = Object.fromEntries(
        (definition.inputSchema.required ?? []).map(name => [
          name, representativeParameter(name, definition.inputSchema.properties[name]),
        ]),
      );
      const result = await server.call(definition.name, args);
      expect(result.isError, `${definition.name}: ${result.text}`).toBe(true);
      expect(result.text.trim().length, definition.name).toBeGreaterThan(0);
      expect(result.text, definition.name).not.toMatch(/TypeError|Unhandled|stack trace/i);
    }
  });

  it('returns structured missing-target failures for runtime tools that advertise target paths', async () => {
    server = await startServer({ allowPrivileged: true });
    expect((await server.call('run_project', { projectPath: server.projectPath })).isError).toBe(false);
    await server.waitForGameConnection();

    const targetNames = new Set([
      'nodePath', 'parentPath', 'rootPath', 'sourcePath', 'targetPath', 'scenePath',
      'cameraPath', 'resourcePath', 'videoPath', 'path',
    ]);
    // This command requires a server-owned shader ID before nodePath becomes
    // meaningful; its missing-node case is statefully covered in
    // runtime-rendering-tools.test.ts after creating the shader.
    const statefulTargetCoverage = new Set(['game_visual_shader']);
    for (const definition of toolDefinitions) {
      const manifest = toolManifest[definition.name];
      if (manifest.backend.kind !== 'runtime') continue;
      const properties = definition.inputSchema.properties;
      const targets = Object.keys(properties).filter(name => targetNames.has(name));
      if (targets.length === 0) continue;
      if (statefulTargetCoverage.has(definition.name)) continue;
      const actions = manifest.actions ?? ['*'];
      let foundMissingTarget = false;
      const diagnostics: string[] = [];
      for (const action of actions) {
        const examples = (definition.inputSchema.examples ?? []) as Record<string, unknown>[];
        const example = examples.find(candidate => action === '*' || candidate.action === action);
        if (!example) continue;
        const semanticExample = Object.fromEntries(Object.entries(example).map(([name, value]) => [
          name,
          name !== 'action' && typeof value === 'string' && properties[name]
            ? representativeParameter(name, properties[name])
            : value,
        ]));
        const branch = action === '*'
          ? undefined
          : definition.inputSchema.oneOf?.find(candidate => candidate.properties?.action?.const === action);
        const allowedTargets = targets.filter(target => branch?.properties?.[target] === undefined);
        for (const target of allowedTargets) {
          const args = {
            ...semanticExample,
            [target]: target === 'path' || ['scenePath', 'resourcePath', 'videoPath'].includes(target)
              ? 'res://definitely_missing_resource.tres'
              : '/root/DefinitelyMissingNode',
          };
          const schemaIssues = validateAgainstSchema(definition.inputSchema, args);
          expect(schemaIssues, `${definition.name}.${action}.${target} fixture must satisfy its advertised schema`).toEqual([]);
          const result = await server.call(definition.name, args);
          diagnostics.push(`${action}.${target}: ${result.text}`);
          if (result.isError && /not found|does not exist|missing|failed to load|no .*resource|invalid target/i.test(result.text)) {
            foundMissingTarget = true;
            break;
          }
        }
        if (foundMissingTarget) break;
      }
      expect(foundMissingTarget, `${definition.name} lacked a missing-target action:\n${diagnostics.join('\n')}`).toBe(true);
    }
  });
});
