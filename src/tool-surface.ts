import {
  toolDefinitions,
  type ToolAnnotations,
  type ToolDefinition,
  type ToolName,
} from './tool-definitions.js';
import { toolManifest, type ToolBackend } from './tool-manifest.js';
import {
  toolCatalogMetadata,
  type ToolEffectScope,
  type ToolMutation,
  type ToolPrivilege,
  type ToolRequiredState,
} from './tool-catalog-metadata.js';
import { COMPACT_STRUCTURED_RESULT_SCHEMA } from './tool-output-schema.js';

export const TOOL_SURFACE_ENV = 'GODOT_MCP_TOOL_SURFACE';
export type ToolSurfaceMode = 'core' | 'full';
export type ToolSurfaceSetting = ToolSurfaceMode | 'compact';

/**
 * Stable, task-oriented starting surface. The complete catalog remains callable
 * through godot_tools and can be advertised directly with TOOL_SURFACE_ENV=full.
 */
export const CORE_TOOL_NAMES: ReadonlySet<ToolName> = new Set([
  'godot_catalog', 'godot_call',
  'launch_editor', 'editor_session', 'editor_control', 'editor_transaction', 'run_project', 'verify_project', 'game_wait_until', 'game_scenario', 'run_project_tests',
  'get_debug_output', 'stop_project', 'get_godot_version', 'get_project_info',
  'create_project', 'create_scene', 'add_node', 'read_scene', 'modify_scene_node',
  'remove_scene_node', 'save_scene', 'create_script', 'attach_script', 'read_file',
  'write_file', 'validate_script', 'validate_scripts', 'read_project_settings',
  'modify_project_settings', 'manage_input_map', 'set_main_scene',
  'game_get_scene_tree', 'game_get_ui', 'game_screenshot', 'game_get_node_info',
  'game_get_errors', 'game_get_logs', 'game_click', 'game_key_press',
  'game_key_hold', 'game_key_release',
]);

export const TOOL_SURFACE_BUDGETS = {
  coreBytesMax: 60_000,
  coreEstimatedTokensMax: 15_000,
  coreReductionPercentMin: 70,
} as const;

const COMPACT_DESCRIPTION_MAX = 37;
const POTENTIALLY_DESTRUCTIVE_TOOLS = new Set<ToolName>([
  'godot_call', 'godot_tools', 'editor_control', 'editor_transaction', 'run_project',
  'write_file', 'delete_file', 'rename_file', 'modify_scene_node', 'remove_scene_node',
  'modify_project_settings', 'manage_input_map', 'manage_export_presets', 'manage_autoloads',
  'manage_addon', 'manage_resource', 'manage_scene_structure', 'manage_scene_signals',
  'manage_layers', 'manage_plugins', 'manage_shader', 'manage_theme_resource',
  'manage_translations', 'set_main_scene', 'game_remove_node', 'game_change_scene',
]);

function compactDescription(description: string): string {
  const firstClause = description.trim().split(/(?<=[.;:])\s/)[0].replace(/\s+/g, ' ');
  if (firstClause.length <= COMPACT_DESCRIPTION_MAX) return firstClause;
  return `${firstClause.slice(0, COMPACT_DESCRIPTION_MAX - 1).trimEnd()}…`;
}

function compactSchemaDescriptions(
  schema: ToolDefinition['inputSchema'],
  depth = 0,
): ToolDefinition['inputSchema'] {
  if (!schema || typeof schema !== 'object') return schema;
  const structural = { ...schema };
  delete structural.description;
  delete structural.examples;
  delete structural['x-invalidExamples'];
  delete structural.properties;
  delete structural.items;
  delete structural.oneOf;
  delete structural.anyOf;
  delete structural.allOf;
  delete structural.not;
  return {
    ...structural,
    ...(depth <= 1 && typeof schema.description === 'string'
      ? { description: compactDescription(schema.description) }
      : {}),
    ...(schema.properties === undefined ? {} : {
      properties: Object.fromEntries(Object.entries(schema.properties).map(
        ([name, property]) => [name, compactSchemaDescriptions(property, depth + 1)],
      )),
    }),
    ...(schema.items === undefined ? {} : { items: compactSchemaDescriptions(schema.items, depth + 1) }),
    ...(schema.oneOf === undefined ? {} : {
      oneOf: schema.oneOf.map(branch => compactSchemaDescriptions(branch, depth + 1)),
    }),
    ...(schema.anyOf === undefined ? {} : {
      anyOf: schema.anyOf.map(branch => compactSchemaDescriptions(branch, depth + 1)),
    }),
    ...(schema.allOf === undefined ? {} : {
      allOf: schema.allOf.map(branch => compactSchemaDescriptions(branch, depth + 1)),
    }),
    ...(schema.not === undefined ? {} : { not: compactSchemaDescriptions(schema.not, depth + 1) }),
  };
}

function annotationsFor(name: ToolName): ToolAnnotations {
  if (name === 'godot_catalog') {
    return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  }
  if (name === 'godot_call' || name === 'godot_tools') {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  }
  const metadata = toolCatalogMetadata[name];
  const readOnly = metadata.mutation === 'read-only';
  return {
    readOnlyHint: readOnly,
    destructiveHint: POTENTIALLY_DESTRUCTIVE_TOOLS.has(name),
    idempotentHint: readOnly,
    openWorldHint: metadata.effectScope === 'external-open-world',
  };
}

function advertisedToolDefinition(definition: ToolDefinition & { readonly name: ToolName }): ToolDefinition {
  return { ...definition, annotations: annotationsFor(definition.name) };
}

function compactToolDefinition(definition: ToolDefinition & { readonly name: ToolName }): ToolDefinition {
  return {
    ...advertisedToolDefinition(definition),
    description: compactDescription(definition.description),
    inputSchema: compactSchemaDescriptions(definition.inputSchema),
    ...(definition.outputSchema === undefined
      ? {}
      : { outputSchema: COMPACT_STRUCTURED_RESULT_SCHEMA }),
  };
}

export function resolveToolSurfaceMode(value = process.env[TOOL_SURFACE_ENV]): ToolSurfaceMode {
  if (value === undefined || value === '' || value === 'core' || value === 'compact') return 'core';
  if (value === 'full') return 'full';
  throw new Error(`Unknown ${TOOL_SURFACE_ENV} value: ${value}. Expected core, compact, or full.`);
}

export function advertisedToolDefinitions(
  mode: ToolSurfaceMode = resolveToolSurfaceMode(),
): readonly ToolDefinition[] {
  return mode === 'full'
    ? toolDefinitions.map(advertisedToolDefinition)
    : toolDefinitions.filter(definition => CORE_TOOL_NAMES.has(definition.name)).map(compactToolDefinition);
}

export function compactToolSurfaceBytes(definitions: readonly ToolDefinition[]): number {
  return Buffer.byteLength(JSON.stringify(definitions), 'utf8');
}

export function estimatedToolSurfaceTokens(definitions: readonly ToolDefinition[]): number {
  return Math.ceil(compactToolSurfaceBytes(definitions) / 4);
}

export interface ToolCatalogSearchOptions {
  domain?: 'lifecycle' | 'project' | 'game';
  backend?: ToolBackend['kind'];
  effect?: ToolEffectScope;
  state?: ToolRequiredState;
  privilege?: ToolPrivilege | boolean;
  mutation?: ToolMutation;
  limit?: number;
}

export type ToolCatalogDetail = 'summary' | 'schema' | 'full';

interface WeightedField {
  name: string;
  weight: number;
  values: readonly string[];
}

const TOKEN_EQUIVALENTS: Readonly<Record<string, readonly string[]>> = {
  addon: ['plugin'],
  addons: ['addon', 'plugin'],
  csharp: ['dotnet'],
  dependencies: ['dependency'],
  dependancies: ['dependency'],
  dotnet: ['csharp'],
  held: ['hold'],
  imports: ['import'],
  labels: ['label', 'text'],
  lighting: ['light'],
  ligthing: ['light'],
  moving: ['movement', 'move'],
  readiness: ['ready'],
  screnshot: ['screenshot'],
  sounds: ['audio', 'sound'],
};

function normalizeSearchText(value: string): string {
  return value.normalize('NFKD')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function searchTokens(value: string): string[] {
  return normalizeSearchText(value).split(/\s+/).filter(Boolean);
}

function singularize(token: string): string {
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('s') && !token.endsWith('ss') && token.length > 3) return token.slice(0, -1);
  return token;
}

function tokenForms(token: string): string[] {
  const normalized = singularize(token);
  return [...new Set([token, normalized, ...(TOKEN_EQUIVALENTS[token] ?? []), ...(TOKEN_EQUIVALENTS[normalized] ?? [])])];
}

function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > 2) return 3;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    let diagonal = previous[0];
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const above = previous[rightIndex];
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function tokenMatchScore(queryToken: string, candidateTokens: readonly string[], weight: number): number {
  let best = 0;
  for (const form of tokenForms(queryToken)) {
    for (const candidate of candidateTokens) {
      if (form === candidate) best = Math.max(best, weight);
      else if (candidate.startsWith(form) || form.startsWith(candidate)) best = Math.max(best, weight * 0.72);
      else {
        const distance = editDistance(form, candidate);
        const limit = Math.max(form.length, candidate.length) >= 7 ? 2 : 1;
        if (distance <= limit) best = Math.max(best, weight * (distance === 1 ? 0.64 : 0.45));
      }
    }
  }
  return best;
}

function searchOptions(domainOrOptions?: string | ToolCatalogSearchOptions, legacyLimit = 20): ToolCatalogSearchOptions {
  return typeof domainOrOptions === 'string'
    ? { domain: domainOrOptions as ToolCatalogSearchOptions['domain'], limit: legacyLimit }
    : { ...(domainOrOptions ?? {}), limit: domainOrOptions?.limit ?? legacyLimit };
}

function matchesFilters(name: ToolName, options: ToolCatalogSearchOptions): boolean {
  const manifest = toolManifest[name];
  const metadata = toolCatalogMetadata[name];
  const privilege = typeof options.privilege === 'boolean'
    ? options.privilege ? 'required' : 'none'
    : options.privilege;
  return (!options.domain || manifest.domain === options.domain)
    && (!options.backend || manifest.backend.kind === options.backend)
    && (!options.effect || metadata.effectScope === options.effect)
    && (!options.state || metadata.requiredState === options.state)
    && (!privilege || metadata.privilege === privilege)
    && (!options.mutation || metadata.mutation === options.mutation);
}

export function searchToolCatalog(
  query: string,
  domainOrOptions?: string | ToolCatalogSearchOptions,
  limit = 20,
): Record<string, unknown>[] {
  const options = searchOptions(domainOrOptions, limit);
  const queryText = normalizeSearchText(query);
  const terms = searchTokens(query);
  const requestedLimit = Math.max(1, Math.min(50, options.limit ?? 20));
  return toolDefinitions
    .flatMap(definition => {
      const manifest = toolManifest[definition.name];
      const metadata = toolCatalogMetadata[definition.name];
      if (!matchesFilters(definition.name, options)) return [];
      const fields: WeightedField[] = [
        { name: 'name', weight: 42, values: [definition.name] },
        { name: 'alias', weight: 34, values: metadata.aliases },
        { name: 'action', weight: 28, values: manifest.actions ?? [] },
        { name: 'concept', weight: 24, values: metadata.concepts },
        { name: 'intent', weight: 22, values: metadata.intentTags },
        { name: 'summary', weight: 12, values: [metadata.summary, metadata.purpose] },
      ];
      let score = 0;
      const reasons: string[] = [];
      const normalizedName = normalizeSearchText(definition.name);
      if (queryText && queryText === normalizedName) {
        score += 180;
        reasons.push('exact tool name');
      }
      for (const field of fields) {
        const phrases = field.values.map(normalizeSearchText);
        if (queryText && phrases.includes(queryText)) {
          score += field.weight * 2;
          reasons.push(`exact ${field.name} phrase`);
        } else if (queryText && phrases.some(phrase => phrase.includes(queryText))) {
          score += field.weight * 0.8;
          reasons.push(`${field.name} phrase`);
        }
        const candidateTokens = phrases.flatMap(searchTokens);
        const tokenScores = terms.map(term => tokenMatchScore(term, candidateTokens, field.weight));
        const matched = tokenScores.filter(value => value > 0);
        if (matched.length > 0) {
          score += matched.reduce((sum, value) => sum + value, 0);
          reasons.push(`${field.name} tokens ${matched.length}/${Math.max(1, terms.length)}`);
        }
      }
      const matchedTerms = terms.filter(term => fields.some(field => {
        const candidateTokens = field.values.flatMap(searchTokens);
        return tokenMatchScore(term, candidateTokens, 1) > 0;
      })).length;
      if (terms.length > 0) score *= matchedTerms / terms.length;
      if (queryText && score === 0) return [];
      return [{
        name: definition.name,
        domain: manifest.domain,
        backend: manifest.backend.kind,
        description: definition.description,
        title: metadata.title,
        actions: manifest.actions ?? ['*'],
        privileged: manifest.privileged,
        effectScope: metadata.effectScope,
        requiredState: metadata.requiredState,
        mutation: metadata.mutation,
        score: Number(score.toFixed(2)),
        matchReasons: [...new Set(reasons)],
      }];
    })
    .sort((left, right) => Number(right.score) - Number(left.score)
      || String(left.name).localeCompare(String(right.name)))
    .slice(0, requestedLimit);
}

export function describeCatalogTool(
  name: string,
  detail: ToolCatalogDetail = 'summary',
): Record<string, unknown> | undefined {
  const definition = toolDefinitions.find(candidate => candidate.name === name);
  if (!definition) return undefined;
  const manifest = toolManifest[definition.name];
  const metadata = toolCatalogMetadata[definition.name];
  const summary = {
    name: definition.name,
    title: metadata.title,
    summary: metadata.summary,
    domain: manifest.domain,
    backend: manifest.backend.kind,
    actions: manifest.actions ?? ['*'],
    effectScope: metadata.effectScope,
    requiredState: metadata.requiredState,
    mutation: metadata.mutation,
    privilege: metadata.privilege,
    core: CORE_TOOL_NAMES.has(definition.name),
  };
  if (detail === 'summary') return summary;
  if (detail === 'schema') return { ...summary, definition };
  return { ...summary, definition, metadata, backendDetails: manifest.backend };
}
