#!/usr/bin/env node

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  advertisedToolDefinitions,
  compactToolSurfaceBytes,
  estimatedToolSurfaceTokens,
  CORE_TOOL_NAMES,
  TOOL_SURFACE_BUDGETS,
} from '../build/tool-surface.js';
import { toolDefinitions, JSON_SCHEMA_DIALECT } from '../build/tool-definitions.js';
import { toolManifest } from '../build/tool-manifest.js';
import { toolCatalogMetadata } from '../build/tool-catalog-metadata.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = join(root, 'docs', 'coverage', 'tool-surface.json');

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function countBy(entries, keyOf) {
  const counts = {};
  for (const entry of entries) {
    const key = keyOf(entry);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function propertyNodes(schema, state = { nodes: 0, described: 0 }) {
  if (!schema || typeof schema !== 'object') return state;
  if (schema.properties && typeof schema.properties === 'object') {
    const properties = Object.entries(schema.properties);
    state.nodes += properties.length;
    state.described += properties.filter(([, value]) =>
      typeof value === 'object' && value !== null && typeof value.description === 'string').length;
    for (const [, value] of properties) propertyNodes(value, state);
  }
  if (schema.items) propertyNodes(schema.items, state);
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(schema[key])) for (const branch of schema[key]) propertyNodes(branch, state);
  }
  if (schema.not) propertyNodes(schema.not, state);
  return state;
}

function skillToolReferences() {
  const references = {};
  const skillsRoot = join(root, 'agent-plugin', 'skills');
  const catalogNames = new Set(toolDefinitions.map(definition => definition.name));
  const directories = readdirSync(skillsRoot).sort();
  for (const directory of directories) {
    const source = readFileSync(join(skillsRoot, directory, 'SKILL.md'), 'utf8');
    const tools = [];
    for (const match of source.matchAll(/`([^`\n]+)`/g)) {
      const name = match[1].trim();
      if (!TOOL_NAME_PATTERN.test(name)) continue;
      if (!tools.includes(name)) tools.push(name);
    }
    references[directory] = {
      tools,
      invalidToolReferences: tools.filter(name => !catalogNames.has(name)),
    };
  }
  return references;
}

const full = advertisedToolDefinitions('full');
const core = advertisedToolDefinitions('core');
const fullBytes = compactToolSurfaceBytes(full);
const coreBytes = compactToolSurfaceBytes(core);

const inputPropertyNodes = { nodes: 0, described: 0 };
const coverageState = {
  catalogMetadata: 0,
  withInputSchema: 0,
  dialectDeclared: 0,
  closedTopLevel: 0,
  withOutputSchema: 0,
  titleFromCatalog: 0,
  titleFromDefinition: 0,
  annotated: 0,
  hintCounts: { readOnlyHint: 0, destructiveHint: 0, idempotentHint: 0, openWorldHint: 0 },
};

for (const definition of full) {
  const metadata = toolCatalogMetadata[definition.name];
  if (metadata) coverageState.catalogMetadata += 1;
  if (metadata?.title) coverageState.titleFromCatalog += 1;
  if (definition.title) coverageState.titleFromDefinition += 1;
  if (definition.inputSchema) {
    coverageState.withInputSchema += 1;
    if (definition.inputSchema.$schema === JSON_SCHEMA_DIALECT) coverageState.dialectDeclared += 1;
    if (definition.inputSchema.additionalProperties === false) coverageState.closedTopLevel += 1;
    propertyNodes(definition.inputSchema, inputPropertyNodes);
  }
  if (definition.outputSchema) coverageState.withOutputSchema += 1;
  if (definition.annotations) {
    coverageState.annotated += 1;
    for (const hint of Object.keys(coverageState.hintCounts)) {
      if (hint in definition.annotations) coverageState.hintCounts[hint] += 1;
    }
  }
}

const manifestEntries = toolDefinitions.map(definition => toolManifest[definition.name]);
const metadataEntries = toolDefinitions.map(definition => toolCatalogMetadata[definition.name]);

const report = {
  schemaVersion: 2,
  measurement: {
    bytes: 'UTF-8 byte length of compact JSON.stringify(toolDefinitions)',
    estimatedTokens: 'ceil(bytes / 4); deterministic planning estimate, not a model tokenizer',
  },
  budgets: {
    coreBytesMax: TOOL_SURFACE_BUDGETS.coreBytesMax,
    coreEstimatedTokensMax: TOOL_SURFACE_BUDGETS.coreEstimatedTokensMax,
    coreReductionPercentMin: TOOL_SURFACE_BUDGETS.coreReductionPercentMin,
  },
  full: {
    tools: full.length,
    bytes: fullBytes,
    estimatedTokens: estimatedToolSurfaceTokens(full),
  },
  core: {
    tools: core.length,
    bytes: coreBytes,
    estimatedTokens: estimatedToolSurfaceTokens(core),
  },
  coreByteReductionPercent: Number(((fullBytes - coreBytes) / fullBytes * 100).toFixed(2)),
  counts: {
    domains: countBy(manifestEntries, entry => entry.domain),
    backends: countBy(manifestEntries, entry => entry.backend.kind),
    actions: {
      toolsWithActions: manifestEntries.filter(entry => Array.isArray(entry.actions) && entry.actions.length > 0).length,
      declaredActions: manifestEntries.reduce((sum, entry) => sum + (entry.actions ?? []).length, 0),
    },
    privilege: countBy(metadataEntries, entry => entry.privilege),
    effectScopes: countBy(metadataEntries, entry => entry.effectScope),
    requiredStates: countBy(metadataEntries, entry => entry.requiredState),
    mutation: countBy(metadataEntries, entry => entry.mutation),
  },
  membership: {
    core: [...CORE_TOOL_NAMES].sort(),
    hidden: toolDefinitions
      .map(definition => definition.name)
      .filter(name => !CORE_TOOL_NAMES.has(name))
      .sort(),
  },
  coverage: {
    catalogMetadata: {
      complete: coverageState.catalogMetadata,
      total: toolDefinitions.length,
    },
    inputSchemas: {
      declared: coverageState.withInputSchema,
      dialectDeclared: coverageState.dialectDeclared,
      closedTopLevel: coverageState.closedTopLevel,
      propertyNodes: inputPropertyNodes.nodes,
      describedPropertyNodes: inputPropertyNodes.described,
    },
    outputSchemas: {
      declared: coverageState.withOutputSchema,
      total: toolDefinitions.length,
    },
    titles: {
      catalogMetadata: coverageState.titleFromCatalog,
      advertised: coverageState.titleFromDefinition,
      total: toolDefinitions.length,
    },
    annotations: {
      declared: coverageState.annotated,
      total: toolDefinitions.length,
      hints: coverageState.hintCounts,
    },
  },
  skillToolReferences: skillToolReferences(),
};

writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`wrote ${outputPath}\n`);
process.stdout.write(`core=${core.length} tools / ${coreBytes} bytes / ${estimatedToolSurfaceTokens(core)} tokens; `);
process.stdout.write(`full=${full.length} tools / ${fullBytes} bytes / ${estimatedToolSurfaceTokens(full)} tokens; `);
process.stdout.write(`reduction ${report.coreByteReductionPercent}%\n`);
