// @test-kind: contract
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepoFile, repoRoot } from './helpers/manifest-sources.js';

/**
 * Every test suite must declare what kind of evidence it produces, so the
 * coverage report can never present mocked-transport tests as integration
 * coverage. The taxonomy is fixed:
 *
 * - `unit`: exercises TypeScript in isolation, doubles allowed.
 * - `contract`: asserts consistency between source artifacts (schemas,
 *   registries, manifests, GDScript sources) without running Godot.
 * - `integration`: runs a real Godot engine. Only suites under tests/godot/
 *   may claim it.
 * - `e2e`: drives the built MCP server as a client against real Godot. Only
 *   suites under tests/e2e/ may claim it.
 */

const VALID_KINDS = ['unit', 'contract', 'integration', 'e2e'] as const;

function declaredKind(relativePath: string): string | null {
  const head = readRepoFile(relativePath).split('\n').slice(0, 5).join('\n');
  const match = /@test-kind:\s*(\S+)/.exec(head);
  return match ? match[1] : null;
}

function testFiles(directory: string, suffix: string): string[] {
  return readdirSync(join(repoRoot, directory))
    .filter(file => file.endsWith(suffix))
    .map(file => `${directory}/${file}`);
}

const typescriptSuites = testFiles('tests', '.test.ts');
const godotSuites = testFiles('tests/godot', '.sh').filter(file => !file.endsWith('godot-bin.sh'));

describe('test metadata', () => {
  it('declares a valid kind at the top of every TypeScript test file', () => {
    for (const file of typescriptSuites) {
      const kind = declaredKind(file);
      expect(kind, `${file} must declare // @test-kind: <${VALID_KINDS.join('|')}>`).not.toBeNull();
      expect(VALID_KINDS, `${file} kind`).toContain(kind);
    }
  });

  it('declares a valid kind in every Godot suite runner', () => {
    expect(godotSuites.length).toBeGreaterThanOrEqual(3);
    for (const file of godotSuites) {
      const kind = declaredKind(file);
      expect(kind, `${file} must declare # @test-kind: <${VALID_KINDS.join('|')}>`).not.toBeNull();
      expect(VALID_KINDS, `${file} kind`).toContain(kind);
    }
  });

  it('reserves integration for suites that run real Godot', () => {
    for (const file of typescriptSuites) {
      expect(declaredKind(file), `${file} cannot claim integration without running Godot`)
        .not.toBe('integration');
    }
    for (const file of godotSuites) {
      expect(declaredKind(file), `${file} runs real Godot`).toBe('integration');
    }
  });

  it('reserves e2e for suites under tests/e2e/', () => {
    for (const file of [...typescriptSuites, ...godotSuites]) {
      if (file.startsWith('tests/e2e/')) continue;
      expect(declaredKind(file), file).not.toBe('e2e');
    }
  });
});
