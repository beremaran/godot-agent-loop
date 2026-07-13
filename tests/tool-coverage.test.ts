// @test-kind: contract
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toolManifest } from '../src/tool-manifest.js';
import { toolDefinitions, type ToolName } from '../src/tool-definitions.js';
import { repoRoot } from './helpers/manifest-sources.js';

/**
 * Validates docs/coverage/tool-coverage.json, the per-tool coverage inventory
 * behind the generated coverage report. The rules make coverage claims
 * mechanically honest: every advertised tool and every declared action must
 * appear, every test reference must resolve to real test source, and a gap can
 * only be recorded as an explicit untested reason, never by omission.
 */

const COVERAGE_LEVELS = ['E2E', 'H', 'G+', 'G-', 'T'] as const;

/** The required test dimensions from TODO.md; "not applicable" must be recorded, never omitted. */
const REQUIRED_DIMENSIONS = [
  'happy-path', 'parameters', 'failures', 'repeatability', 'cleanup',
  'persistence', 'frame-behavior', 'exotic-paths', 'limits',
  'compatibility', 'platforms', 'build-flavors', 'security',
] as const;

interface ActionCoverage {
  tests?: string[];
  untested?: string;
}
interface ToolCoverage {
  level: (typeof COVERAGE_LEVELS)[number];
  tests: string[];
  actions: Record<string, ActionCoverage>;
  dimensions: Record<string, string>;
}

const coverage = JSON.parse(
  readFileSync(join(repoRoot, 'docs/coverage/tool-coverage.json'), 'utf8'),
) as { tools: Record<string, ToolCoverage> };

const fileCache = new Map<string, string>();
function referencedFile(relativePath: string): string | null {
  if (!fileCache.has(relativePath)) {
    const absolute = join(repoRoot, relativePath);
    fileCache.set(relativePath, existsSync(absolute) ? readFileSync(absolute, 'utf8') : '');
  }
  const content = fileCache.get(relativePath)!;
  return content === '' ? null : content;
}

function assertReferences(context: string, references: string[]): void {
  for (const reference of references) {
    const separator = reference.indexOf('::');
    expect(separator, `${context}: reference "${reference}" must be "file::needle"`).toBeGreaterThan(0);
    const file = reference.slice(0, separator);
    const needle = reference.slice(separator + 2);
    const content = referencedFile(file);
    expect(content, `${context}: referenced file ${file} does not exist`).not.toBeNull();
    expect(content!.includes(needle), `${context}: "${needle}" not found in ${file}`).toBe(true);
  }
}

describe('tool coverage inventory', () => {
  it('covers exactly the manifest tools', () => {
    expect(Object.keys(coverage.tools).sort()).toEqual(Object.keys(toolManifest).sort());
  });

  it('declares a valid coverage level for every tool', () => {
    for (const [name, tool] of Object.entries(coverage.tools)) {
      expect(COVERAGE_LEVELS, `${name} level`).toContain(tool.level);
    }
  });

  it('lists exactly the manifest actions for every tool', () => {
    for (const [name, tool] of Object.entries(coverage.tools)) {
      const declared = toolManifest[name as ToolName].actions;
      const keys = Object.keys(tool.actions).sort();
      if (declared === null) {
        expect(keys, `${name} single-action key`).toEqual(['*']);
      } else {
        expect(keys, `${name} action rows`).toEqual([...declared].sort());
      }
    }
  });

  it('records every action either with resolving test references or an explicit untested reason', () => {
    for (const [name, tool] of Object.entries(coverage.tools)) {
      for (const [action, row] of Object.entries(tool.actions)) {
        const context = `${name}.${action}`;
        const hasTests = Array.isArray(row.tests) && row.tests.length > 0;
        const hasReason = typeof row.untested === 'string' && row.untested.length > 0;
        expect(hasTests !== hasReason, `${context} must have tests XOR an untested reason`).toBe(true);
        if (hasTests) assertReferences(context, row.tests!);
      }
    }
  });

  it('resolves every tool-level test reference', () => {
    for (const [name, tool] of Object.entries(coverage.tools)) {
      assertReferences(name, tool.tests);
    }
  });

  it('records every required test dimension as applicable or explicitly not applicable', () => {
    for (const [name, tool] of Object.entries(coverage.tools)) {
      expect(Object.keys(tool.dimensions).sort(), `${name} dimension keys`)
        .toEqual([...REQUIRED_DIMENSIONS].sort());
      for (const [dimension, status] of Object.entries(tool.dimensions)) {
        expect(
          status === 'applicable' || status.startsWith('n/a: '),
          `${name}.${dimension} must be "applicable" or "n/a: <reason>", got "${status}"`,
        ).toBe(true);
      }
    }
  });

  it('backs each coverage level with evidence from the matching suite', () => {
    const requiredSource: Record<string, (reference: string) => boolean> = {
      'E2E': reference => reference.startsWith('tests/e2e/'),
      'H': reference => reference.startsWith('tests/godot/run-headless-operations.sh'),
      'G+': reference => reference.startsWith('tests/godot/fixture/'),
      'G-': reference => reference.startsWith('tests/godot/fixture/'),
      'T': () => true,
    };
    for (const [name, tool] of Object.entries(coverage.tools)) {
      const allReferences = [
        ...tool.tests,
        ...Object.values(tool.actions).flatMap(row => row.tests ?? []),
      ];
      expect(
        allReferences.some(requiredSource[tool.level]),
        `${name} claims ${tool.level} but has no reference into the required suite`,
      ).toBe(true);
    }
  });

  it('names every public parameter and enum value in the tool\'s referenced E2E evidence', () => {
    for (const definition of toolDefinitions) {
      const tool = coverage.tools[definition.name];
      const references = [
        ...tool.tests,
        ...Object.values(tool.actions).flatMap(row => row.tests ?? []),
      ].filter(reference => reference.startsWith('tests/e2e/'));
      const files = [...new Set(references.map(reference => reference.split('::')[0]))];
      const evidence = files.map(file => referencedFile(file) ?? '').join('\n');
      for (const [parameter, schema] of Object.entries(definition.inputSchema.properties)) {
        expect(evidence, `${definition.name}.${parameter} lacks referenced E2E parameter evidence`)
          .toMatch(new RegExp(`\\b${parameter}\\b`));
        for (const value of schema.enum ?? []) {
          expect(
            evidence.includes(`'${value}'`) || evidence.includes(`"${value}"`),
            `${definition.name}.${parameter}=${value} lacks referenced E2E enum evidence`,
          ).toBe(true);
        }
      }
    }
  });
});
