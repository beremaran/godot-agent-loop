// @test-kind: contract
import { describe, expect, it } from 'vitest';
import { toolDefinitions } from '../src/tool-definitions.js';
import {
  COMMON_STRUCTURED_RESULT_SCHEMA,
  COMPACT_STRUCTURED_RESULT_SCHEMA,
  structuredResultSchemaFor,
} from '../src/tool-output-schema.js';
import {
  CORE_TOOL_NAMES,
  TOOL_SURFACE_BUDGETS,
  advertisedToolDefinitions,
  compactToolSurfaceBytes,
  describeCatalogTool,
  estimatedToolSurfaceTokens,
  resolveToolSurfaceMode,
  searchToolCatalog,
} from '../src/tool-surface.js';

describe('progressive tool surface', () => {
  it('defaults to a stable core while retaining an explicit full mode', () => {
    expect(resolveToolSurfaceMode(undefined)).toBe('core');
    expect(resolveToolSurfaceMode('')).toBe('core');
    expect(resolveToolSurfaceMode('core')).toBe('core');
    expect(resolveToolSurfaceMode('compact')).toBe('core');
    expect(resolveToolSurfaceMode('full')).toBe('full');
    expect(() => resolveToolSurfaceMode('invalid')).toThrow(/Expected core, compact, or full/);
    expect(advertisedToolDefinitions('full').map(tool => tool.name)).toEqual(toolDefinitions.map(tool => tool.name));
    expect(advertisedToolDefinitions('core').map(tool => tool.name))
      .toEqual(toolDefinitions.filter(tool => CORE_TOOL_NAMES.has(tool.name)).map(tool => tool.name));
  });

  it('keeps the complete build-game loop directly visible', () => {
    const names = CORE_TOOL_NAMES;
    for (const required of [
      'godot_catalog', 'godot_call', 'create_project', 'create_scene', 'create_script', 'attach_script',
      'manage_input_map', 'set_main_scene', 'run_project', 'game_get_scene_tree',
      'game_get_ui', 'game_screenshot', 'verify_project', 'run_project_tests',
      'game_key_hold', 'game_key_release',
    ] as const) expect(names.has(required), required).toBe(true);
    expect(names.has('godot_tools')).toBe(false);
  });

  it('enforces byte, estimated-token, and reduction budgets without an exact count cap', () => {
    const core = advertisedToolDefinitions('core');
    const fullBytes = compactToolSurfaceBytes(toolDefinitions);
    const coreBytes = compactToolSurfaceBytes(core);
    expect(toolDefinitions.length).toBeGreaterThan(core.length);
    expect(coreBytes).toBeLessThanOrEqual(TOOL_SURFACE_BUDGETS.coreBytesMax);
    expect(estimatedToolSurfaceTokens(core)).toBeLessThanOrEqual(TOOL_SURFACE_BUDGETS.coreEstimatedTokensMax);
    expect((1 - coreBytes / fullBytes) * 100).toBeGreaterThanOrEqual(TOOL_SURFACE_BUDGETS.coreReductionPercentMin);
  });

  it('compacts input descriptions while retaining a self-contained output contract', () => {
    const compact = advertisedToolDefinitions('core');
    const authored = toolDefinitions.filter(tool => CORE_TOOL_NAMES.has(tool.name));
    const withoutDescriptions = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(withoutDescriptions);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !['description', 'annotations', 'examples', 'x-invalidExamples'].includes(key))
        .map(([key, item]) => [key, withoutDescriptions(item)]));
    };
    expect(compact.map(tool => withoutDescriptions(tool.inputSchema)))
      .toEqual(authored.map(tool => withoutDescriptions(tool.inputSchema)));
    expect(compact.every(tool => tool.outputSchema === COMPACT_STRUCTURED_RESULT_SCHEMA)).toBe(true);
    for (const tool of authored) expect(tool.outputSchema).toEqual(structuredResultSchemaFor(tool.name));
    expect(authored.find(tool => tool.name === 'game_scenario')?.outputSchema)
      .not.toBe(COMMON_STRUCTURED_RESULT_SCHEMA);

    const descriptions: string[] = [];
    const collectDescriptions = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(collectDescriptions);
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'description' && typeof item === 'string') descriptions.push(item);
        else collectDescriptions(item);
      }
    };
    collectDescriptions(compact);
    expect(descriptions.length).toBeGreaterThan(0);
    expect(descriptions.every(description => description.trim().length > 0)).toBe(true);
    expect(Math.max(...descriptions.map(description => description.length))).toBeLessThanOrEqual(37);
  });

  it('advertises titles and conservative annotations across the full surface', () => {
    const full = advertisedToolDefinitions('full');
    for (const definition of full) {
      expect(definition.title?.trim(), `${definition.name}.title`).not.toBe('');
      expect(definition.annotations, definition.name).toMatchObject({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
    }
    expect(full.find(tool => tool.name === 'godot_catalog')?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(full.find(tool => tool.name === 'godot_call')?.annotations).toEqual({
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    });
    expect(full.find(tool => tool.name === 'godot_tools')?.annotations).toEqual({
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    });
  });

  it('supports deterministic catalog filters and ranked debug explanations', () => {
    const first = searchToolCatalog('inspect audio state', {
      domain: 'game', backend: 'runtime', effect: 'read-only', state: 'runtime',
      privilege: false, mutation: 'read-only', limit: 5,
    });
    const second = searchToolCatalog('inspect audio state', {
      domain: 'game', backend: 'runtime', effect: 'read-only', state: 'runtime',
      privilege: 'none', mutation: 'read-only', limit: 5,
    });
    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({
      name: 'game_get_audio', score: expect.any(Number), matchReasons: expect.any(Array),
    });
    expect((first[0].matchReasons as unknown[]).length).toBeGreaterThan(0);
  });

  it('describes summary, schema, and full catalog detail levels', () => {
    const summary = describeCatalogTool('game_key_hold', 'summary')!;
    expect(summary).toMatchObject({ name: 'game_key_hold', title: 'Game Key Hold', core: true });
    expect(summary).not.toHaveProperty('definition');
    expect(describeCatalogTool('game_key_hold')).toEqual(summary);

    const schema = describeCatalogTool('game_key_hold', 'schema')!;
    expect(schema).toMatchObject({ definition: { name: 'game_key_hold', inputSchema: { type: 'object' } } });
    expect(schema).not.toHaveProperty('metadata');

    const full = describeCatalogTool('game_key_hold', 'full')!;
    expect(full).toMatchObject({
      definition: { name: 'game_key_hold' },
      metadata: { effectScope: 'runtime-ephemeral', requiredState: 'runtime' },
      backendDetails: { kind: 'runtime', command: 'key_hold' },
    });
    expect(describeCatalogTool('missing', 'summary')).toBeUndefined();
  });
});
