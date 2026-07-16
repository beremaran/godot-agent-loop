#!/usr/bin/env node
/**
 * Generates docs/coverage/coverage-report.md from the traceability manifest
 * (src/tool-manifest.ts, via the build output) and the coverage inventory
 * (docs/coverage/tool-coverage.json). All denominators are derived from
 * source, never hand-written.
 *
 * Usage:
 *   node scripts/generate-coverage-report.js          # rewrite the report
 *   node scripts/generate-coverage-report.js --check  # fail if the report is stale
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { toolDefinitions } = await import(join(root, 'build/tool-definitions.js'));
const { toolManifest } = await import(join(root, 'build/tool-manifest.js'));
const { toolCatalogMetadata } = await import(join(root, 'build/tool-catalog-metadata.js'));
const {
  TOOL_SURFACE_BUDGETS,
  advertisedToolDefinitions,
  compactToolSurfaceBytes,
  estimatedToolSurfaceTokens,
} = await import(join(root, 'build/tool-surface.js'));
const { AUTHORING_COMMANDS, RUNTIME_COMMANDS, SESSION_COMMANDS, PRIVILEGED_RUNTIME_COMMANDS } = await import(join(root, 'build/runtime-protocol.js'));

const coverage = JSON.parse(readFileSync(join(root, 'docs/coverage/tool-coverage.json'), 'utf8'));
const loopLatency = JSON.parse(readFileSync(join(root, 'docs/coverage/loop-latency.json'), 'utf8'));
const reportPath = join(root, 'docs/coverage/coverage-report.md');
const toolSurfacePath = join(root, 'docs/coverage/tool-surface.json');
const readmePath = join(root, 'README.md');

const LEVELS = ['E2E', 'H', 'G+', 'G-', 'T'];
const LEVEL_MEANING = {
  'E2E': 'Complete MCP-to-Godot path with independent observation',
  'H': 'Headless GDScript operation exercised directly against Godot',
  'G+': 'Runtime command reaches real Godot with at least one successful behavior',
  'G-': 'Runtime command reaches real Godot on a negative path only',
  'T': 'TypeScript, source-contract, schema, or mocked-transport coverage only',
};

const tools = toolDefinitions.map(def => {
  const manifest = toolManifest[def.name];
  const entry = coverage.tools[def.name];
  const actionRows = Object.entries(entry.actions);
  const tested = actionRows.filter(([, row]) => Array.isArray(row.tests) && row.tests.length > 0).length;
  return { name: def.name, manifest, entry, actions: actionRows.length, testedActions: tested };
});

const subprocessOperations = new Set(
  tools.flatMap(tool => {
    if (tool.manifest.backend.kind === 'subprocess') return [tool.manifest.backend.operation];
    if (tool.manifest.backend.kind === 'authoring-session') return [tool.manifest.backend.fallback.operation];
    return [];
  }),
);
const levelCounts = Object.fromEntries(LEVELS.map(level => [level, tools.filter(tool => tool.entry.level === level).length]));
const totalActions = tools.reduce((sum, tool) => sum + tool.actions, 0);
const totalTested = tools.reduce((sum, tool) => sum + tool.testedActions, 0);
const coreToolDefinitions = advertisedToolDefinitions('core');
const fullAdvertisedToolDefinitions = advertisedToolDefinitions('full');
const fullSurfaceBytes = compactToolSurfaceBytes(toolDefinitions);
const coreSurfaceBytes = compactToolSurfaceBytes(coreToolDefinitions);
const reductionPercent = (1 - coreSurfaceBytes / fullSurfaceBytes) * 100;

function countsBy(values) {
  return Object.fromEntries([...new Set(values)].sort().map(value => [
    value, values.filter(candidate => candidate === value).length,
  ]));
}

function schemaDescriptionCoverage(schema) {
  let propertyNodes = 0;
  let describedPropertyNodes = 0;
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const property of Object.values(value.properties ?? {})) {
      propertyNodes += 1;
      if (typeof property.description === 'string' && property.description.trim() !== '') {
        describedPropertyNodes += 1;
      }
      visit(property);
    }
    if (value.items) visit(value.items);
    for (const branch of value.oneOf ?? []) visit(branch);
    for (const branch of value.anyOf ?? []) visit(branch);
    for (const branch of value.allOf ?? []) visit(branch);
  };
  visit(schema);
  return { propertyNodes, describedPropertyNodes };
}

function skillToolReferences() {
  const skillsRoot = join(root, 'agent-plugin/skills');
  const toolNames = new Set(toolDefinitions.map(definition => definition.name));
  return Object.fromEntries(readdirSync(skillsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => {
      const source = readFileSync(join(skillsRoot, entry.name, 'SKILL.md'), 'utf8');
      const references = [...source.matchAll(/`([a-z][a-z0-9_]*)`/g)].map(match => match[1]);
      return [entry.name, {
        tools: [...new Set(references.filter(reference => toolNames.has(reference)))].sort(),
        invalidToolReferences: [...new Set(references.filter(reference => reference.includes('_') && !toolNames.has(reference)))].sort(),
      }];
    }));
}

const inputDescriptions = toolDefinitions.map(definition => schemaDescriptionCoverage(definition.inputSchema));
const coreNames = coreToolDefinitions.map(definition => definition.name);
const coreNameSet = new Set(coreNames);
const advertisedTitles = fullAdvertisedToolDefinitions.filter(
  definition => typeof definition.title === 'string' && definition.title.trim() !== '',
);
const advertisedOutputSchemas = fullAdvertisedToolDefinitions.filter(definition => definition.outputSchema !== undefined);
const advertisedAnnotations = fullAdvertisedToolDefinitions.filter(definition => definition.annotations !== undefined);
const annotationHints = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
const toolSurface = {
  schemaVersion: 2,
  measurement: {
    bytes: 'UTF-8 byte length of compact JSON.stringify(toolDefinitions)',
    estimatedTokens: 'ceil(bytes / 4); deterministic planning estimate, not a model tokenizer',
  },
  budgets: TOOL_SURFACE_BUDGETS,
  full: {
    tools: toolDefinitions.length,
    bytes: fullSurfaceBytes,
    estimatedTokens: estimatedToolSurfaceTokens(toolDefinitions),
  },
  core: {
    tools: coreToolDefinitions.length,
    bytes: coreSurfaceBytes,
    estimatedTokens: estimatedToolSurfaceTokens(coreToolDefinitions),
  },
  coreByteReductionPercent: Number(reductionPercent.toFixed(2)),
  counts: {
    domains: countsBy(tools.map(tool => tool.manifest.domain)),
    backends: countsBy(tools.map(tool => tool.manifest.backend.kind)),
    actions: {
      toolsWithActions: tools.filter(tool => tool.manifest.actions !== null).length,
      declaredActions: tools.reduce((sum, tool) => sum + (tool.manifest.actions?.length ?? 1), 0),
    },
    privilege: {
      required: tools.filter(tool => tool.manifest.privileged).length,
      none: tools.filter(tool => !tool.manifest.privileged).length,
    },
    effectScopes: countsBy(toolDefinitions.map(definition => toolCatalogMetadata[definition.name].effectScope)),
    requiredStates: countsBy(toolDefinitions.map(definition => toolCatalogMetadata[definition.name].requiredState)),
    mutation: countsBy(toolDefinitions.map(definition => toolCatalogMetadata[definition.name].mutation)),
  },
  membership: {
    core: coreNames,
    hidden: toolDefinitions.map(definition => definition.name).filter(name => !coreNameSet.has(name)),
  },
  coverage: {
    catalogMetadata: {
      complete: toolDefinitions.filter(definition => {
        const metadata = toolCatalogMetadata[definition.name];
        return metadata && metadata.title && metadata.summary && metadata.purpose
          && metadata.aliases.length > 0 && metadata.intentTags.length > 0 && metadata.concepts.length > 0;
      }).length,
      total: toolDefinitions.length,
    },
    inputSchemas: {
      declared: toolDefinitions.filter(definition => definition.inputSchema?.type === 'object').length,
      dialectDeclared: toolDefinitions.filter(definition => typeof definition.inputSchema?.$schema === 'string').length,
      closedTopLevel: toolDefinitions.filter(definition => definition.inputSchema?.additionalProperties === false).length,
      propertyNodes: inputDescriptions.reduce((sum, item) => sum + item.propertyNodes, 0),
      describedPropertyNodes: inputDescriptions.reduce((sum, item) => sum + item.describedPropertyNodes, 0),
    },
    outputSchemas: { declared: advertisedOutputSchemas.length, total: toolDefinitions.length },
    titles: {
      catalogMetadata: toolDefinitions.filter(definition => toolCatalogMetadata[definition.name]?.title).length,
      advertised: advertisedTitles.length,
      total: toolDefinitions.length,
    },
    annotations: {
      declared: advertisedAnnotations.length,
      total: toolDefinitions.length,
      hints: Object.fromEntries(annotationHints.map(hint => [
        hint, fullAdvertisedToolDefinitions.filter(definition => definition.annotations?.[hint] !== undefined).length,
      ])),
    },
  },
  skillToolReferences: skillToolReferences(),
};
const toolSurfaceJson = `${JSON.stringify(toolSurface, null, 2)}\n`;

if (coreSurfaceBytes > TOOL_SURFACE_BUDGETS.coreBytesMax
  || toolSurface.core.estimatedTokens > TOOL_SURFACE_BUDGETS.coreEstimatedTokensMax
  || reductionPercent < TOOL_SURFACE_BUDGETS.coreReductionPercentMin) {
  throw new Error(`Tool-surface budget exceeded: ${JSON.stringify(toolSurface)}`);
}
const badgeColor = totalTested === totalActions && levelCounts.E2E === tools.length
  ? 'brightgreen'
  : 'yellow';
const generatedBadge = [
  '<!-- generated-coverage-badge:start -->',
  `[![E2E tools: ${levelCounts.E2E}/${tools.length}](https://img.shields.io/badge/E2E_tools-${levelCounts.E2E}%2F${tools.length}-${badgeColor})](docs/coverage/coverage-report.md)`,
  '<!-- generated-coverage-badge:end -->',
].join('\n');

function backendLabel(backend) {
  if (backend.kind === 'subprocess') return `subprocess \`${backend.operation}\``;
  if (backend.kind === 'authoring-session') {
    return `authoring session \`${backend.command}\` (fallback: subprocess \`${backend.fallback.operation}\`)`;
  }
  if (backend.kind === 'runtime') return `runtime \`${backend.command}\``;
  return backend.kind;
}

const lines = [];
lines.push('# Tool coverage report');
lines.push('');
lines.push('Generated by `scripts/generate-coverage-report.js`. Do not edit by hand;');
lines.push('regenerate with `npm run coverage:report`. `npm run coverage:check` fails');
lines.push('when this file is stale, and the inventory behind it is validated by');
lines.push('`tests/tool-manifest.test.ts` and `tests/tool-coverage.test.ts`.');
lines.push('');
lines.push('## Source-derived denominators');
lines.push('');
lines.push('| Denominator | Count | Source |');
lines.push('| --- | ---: | --- |');
lines.push(`| Default advertised MCP tools | ${coreToolDefinitions.length} | \`src/tool-surface.ts\` |`);
lines.push(`| Full callable tool catalog | ${toolDefinitions.length} | \`src/tool-definitions.ts\` |`);
lines.push(`| Session commands | ${SESSION_COMMANDS.length} | \`src/runtime-protocol.ts\` = \`docs/runtime-api.schema.json\` |`);
lines.push(`| Game runtime commands | ${RUNTIME_COMMANDS.length} | \`src/runtime-protocol.ts\` |`);
lines.push(`| Authoring session commands | ${AUTHORING_COMMANDS.length} | \`src/runtime-protocol.ts\` |`);
lines.push(`| Privileged runtime commands | ${PRIVILEGED_RUNTIME_COMMANDS.length} | \`src/runtime-protocol.ts\` |`);
lines.push(`| Subprocess operations | ${subprocessOperations.size} | \`src/scripts/godot_operations.gd\` |`);
lines.push(`| Public action rows | ${totalActions} | \`src/tool-manifest.ts\` |`);
lines.push('');
lines.push('## Tool-surface budget');
lines.push('');
lines.push('The default static core remains client-independent; `godot_catalog` searches');
lines.push('and describes, while `godot_call` dispatches the full catalog on demand.');
lines.push('The deprecated `godot_tools` alias remains callable only for compatibility. Sizes serialize the exact');
lines.push('definition arrays as compact JSON. The token figure is the plan\'s deterministic');
lines.push('four-bytes-per-token estimate, not a provider tokenizer. Machine-readable values');
lines.push('and budgets are in [`tool-surface.json`](tool-surface.json).');
lines.push('');
lines.push('| Surface | Tools | Bytes | Estimated tokens |');
lines.push('| --- | ---: | ---: | ---: |');
lines.push(`| Full catalog | ${toolSurface.full.tools} | ${toolSurface.full.bytes} | ${toolSurface.full.estimatedTokens} |`);
lines.push(`| Default core | ${toolSurface.core.tools} | ${toolSurface.core.bytes} | ${toolSurface.core.estimatedTokens} |`);
lines.push(`| Reduction | — | ${toolSurface.coreByteReductionPercent.toFixed(2)}% | ${((1 - toolSurface.core.estimatedTokens / toolSurface.full.estimatedTokens) * 100).toFixed(2)}% |`);
lines.push('');
lines.push('## Coverage by class');
lines.push('');
lines.push('| Class | Tools | Meaning |');
lines.push('| --- | ---: | --- |');
for (const level of LEVELS) {
  lines.push(`| ${level} | ${levelCounts[level]} | ${LEVEL_MEANING[level]} |`);
}
lines.push(`| **Total** | **${tools.length}** | |`);
lines.push('');
lines.push('## Action coverage');
lines.push('');
lines.push(`${totalTested} of ${totalActions} action rows declare at least one resolving test`);
lines.push(`reference; ${totalActions - totalTested} are explicitly recorded as untested.`);
lines.push('');
lines.push('## Test suites by declared kind');
lines.push('');
lines.push('Kinds are declared per suite with `@test-kind` and validated by');
lines.push('`tests/test-metadata.test.ts`; "integration" always means a real Godot');
lines.push('engine, never a mocked transport.');
lines.push('');
lines.push('| Kind | Suites |');
lines.push('| --- | --- |');
const suiteFiles = [
  ...readdirSync(join(root, 'tests')).filter(file => file.endsWith('.test.ts')).map(file => `tests/${file}`),
  ...readdirSync(join(root, 'tests/e2e')).filter(file => file.endsWith('.test.ts')).map(file => `tests/e2e/${file}`),
  ...readdirSync(join(root, 'tests/godot')).filter(file => file.endsWith('.sh') && file !== 'godot-bin.sh').map(file => `tests/godot/${file}`),
];
const suitesByKind = new Map();
for (const file of suiteFiles) {
  const head = readFileSync(join(root, file), 'utf8').split('\n').slice(0, 5).join('\n');
  const kind = /@test-kind:\s*(\S+)/.exec(head)?.[1] ?? 'undeclared';
  if (!suitesByKind.has(kind)) suitesByKind.set(kind, []);
  suitesByKind.get(kind).push(file);
}
for (const kind of ['unit', 'contract', 'integration', 'e2e', 'undeclared']) {
  const suites = suitesByKind.get(kind);
  if (!suites) continue;
  lines.push(`| ${kind} | ${suites.map(file => `\`${file}\``).join(', ')} |`);
}
lines.push('');
lines.push('## Authoring loop latency');
lines.push('');
lines.push('The recorded benchmark runs the same realistic edit → headed run → authenticated');
lines.push('scene-tree observation → stop → edit workload through the persistent authoring');
lines.push('session and the retained subprocess-per-operation fallback. It uses one warmup');
lines.push(`and ${loopLatency.methodology.measuredIterationsPerMode} measured fresh projects per mode, alternates mode order, and`);
lines.push('excludes identical MCP transport overhead. Reproduce it with `npm run benchmark:loop`;');
lines.push('the raw samples, environment, methodology, and machine-readable budgets are in');
lines.push('[`loop-latency.json`](loop-latency.json).');
lines.push('');
lines.push(`Recorded on ${loopLatency.environment.godotVersion} / ${loopLatency.environment.platform} / ${loopLatency.environment.cpu}.`);
lines.push('');
lines.push('| Metric | Persistent session | Subprocess baseline | Delta | Budget |');
lines.push('| --- | ---: | ---: | ---: | --- |');
lines.push(`| Full cycle median | ${formatMs(loopLatency.summary.session.medianMs)} | ${formatMs(loopLatency.summary.subprocess.medianMs)} | ${formatSignedPercent(-loopLatency.summary.medianReductionPercent)} slower | ≤ ${formatMs(loopLatency.budgets.sessionCycleMedianMaxMs)} and ≤ ${loopLatency.budgets.sessionToSubprocessMedianRatioMax.toFixed(2)}× baseline |`);
lines.push(`| Full cycle p95 | ${formatMs(loopLatency.summary.session.p95Ms)} | ${formatMs(loopLatency.summary.subprocess.p95Ms)} | — | diagnostic |`);
lines.push(`| Warm authoring command p95 | ${formatMs(loopLatency.summary.warmSessionCommandP95Ms)} | ${formatMs(loopLatency.summary.subprocessOperationP95Ms)} | ${formatSignedPercent(loopLatency.summary.warmCommandP95ReductionPercent)} faster | ≤ ${formatMs(loopLatency.budgets.warmSessionCommandP95MaxMs)} |`);
lines.push(`| Session-starting edit p95 | ${formatMs(loopLatency.summary.sessionStartupP95Ms)} | n/a | — | ≤ ${formatMs(loopLatency.budgets.sessionStartupP95MaxMs)} |`);
lines.push('');
lines.push(`**Headline:** warm commands cut operation p95 by ${loopLatency.summary.warmCommandP95ReductionPercent.toFixed(1)}%, but the current`);
lines.push(`split edit/run lifecycle makes the complete cycle ${(-loopLatency.summary.medianReductionPercent).toFixed(1)}% slower than the`);
lines.push('one-shot baseline because it pays a headed session startup before and after the');
lines.push('running-game process. The persistent transport is fast once warm; preserving that');
lines.push('warm main loop across run/observe is the remaining latency requirement. The current');
lines.push('budgets cap this transitional regression and protect warm-command and startup latency.');
lines.push('');
lines.push('## Per-tool rollup');
lines.push('');
lines.push('| Tool | Backend | Privileged | Level | Actions tested |');
lines.push('| --- | --- | --- | --- | ---: |');
for (const tool of tools) {
  const privileged = tool.manifest.privileged ? 'yes' : 'no';
  lines.push(`| \`${tool.name}\` | ${backendLabel(tool.manifest.backend)} | ${privileged} | ${tool.entry.level} | ${tool.testedActions}/${tool.actions} |`);
}
lines.push('');

const report = lines.join('\n');

function formatMs(value) {
  return `${Number(value).toFixed(2)} ms`;
}

function formatSignedPercent(value) {
  return `${Number(value).toFixed(1)}%`;
}

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(reportPath, 'utf8');
  } catch {
    // Missing report is stale by definition.
  }
  if (current !== report) {
    console.error('docs/coverage/coverage-report.md is stale. Run: npm run coverage:report');
    process.exit(1);
  }
  let currentToolSurface = '';
  try {
    currentToolSurface = readFileSync(toolSurfacePath, 'utf8');
  } catch {
    // Missing generated surface evidence is stale by definition.
  }
  if (currentToolSurface !== toolSurfaceJson) {
    console.error('docs/coverage/tool-surface.json is stale. Run: npm run coverage:report');
    process.exit(1);
  }
  const readme = readFileSync(readmePath, 'utf8');
  if (!readme.includes(generatedBadge)) {
    console.error('README.md coverage badge is stale. Run: npm run coverage:report');
    process.exit(1);
  }
  console.log('coverage report is current');
} else {
  writeFileSync(reportPath, report);
  writeFileSync(toolSurfacePath, toolSurfaceJson);
  const readme = readFileSync(readmePath, 'utf8');
  const badgePattern = /<!-- generated-coverage-badge:start -->[\s\S]*?<!-- generated-coverage-badge:end -->/;
  if (!badgePattern.test(readme)) {
    throw new Error('README.md is missing the generated coverage badge markers');
  }
  writeFileSync(readmePath, readme.replace(badgePattern, generatedBadge));
  console.log(`wrote ${reportPath}`);
}
