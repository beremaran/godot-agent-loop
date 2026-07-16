// @test-kind: contract
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { searchToolCatalog } from '../src/tool-surface.js';
import { repoRoot } from './helpers/manifest-sources.js';

interface DiscoveryCase {
  id: string;
  intent: string;
  query: string;
  expectedTop: string;
  acceptableAlternatives: string[];
  forbiddenAboveExpected: string[];
  maxRank: number;
}

const corpus = JSON.parse(readFileSync(
  join(repoRoot, 'tests/fixtures/discovery-intents.json'), 'utf8',
)) as { schemaVersion: number; cases: DiscoveryCase[] };

describe('ranked tool discovery corpus', () => {
  it('covers every required Phase 0 intent with explicit rank and safety expectations', () => {
    const intents = new Set(corpus.cases.map(testCase => testCase.intent));
    for (const required of [
      'hold input while moving', 'tap a key once', 'release held input',
      'add or change 2D lighting', 'add or change 3D lighting', 'play audio',
      'inspect audio state', 'export a game and inspect readiness', 'rename an asset safely',
      'inspect resource dependencies', 'wait until a label changes',
      'wait until a property changes', 'compare a screenshot', 'create terrain',
      'inspect imports', 'inspect addons', 'inspect .NET status', 'inspect project integrity',
      'persistent scene creation', 'runtime-only node spawning',
    ]) expect(intents, required).toContain(required);
    expect(corpus.cases.some(testCase => testCase.query.includes('_'))).toBe(true);
    expect(corpus.cases.some(testCase => /PointLight2D|AudioStreamPlayer/.test(testCase.query))).toBe(true);
    expect(corpus.cases.some(testCase => /ligthing|dependancies|screnshot/.test(testCase.query))).toBe(true);
  });

  for (const testCase of corpus.cases) {
    it(`${testCase.id}: ranks ${testCase.expectedTop} safely`, () => {
      const results = searchToolCatalog(testCase.query, { limit: 10 });
      const names = results.map(result => String(result.name));
      const expectedIndex = names.indexOf(testCase.expectedTop);
      expect(expectedIndex, `${testCase.query}: ${names.join(', ')}`).toBeGreaterThanOrEqual(0);
      expect(expectedIndex + 1, `${testCase.query}: ${names.join(', ')}`).toBeLessThanOrEqual(testCase.maxRank);
      expect(names[0], `${testCase.query}: ${names.join(', ')}`).toBe(testCase.expectedTop);
      for (const forbidden of testCase.forbiddenAboveExpected) {
        const forbiddenIndex = names.indexOf(forbidden);
        expect(
          forbiddenIndex === -1 || forbiddenIndex > expectedIndex,
          `${testCase.query}: forbidden ${forbidden} ranked above ${testCase.expectedTop}`,
        ).toBe(true);
      }
      for (const alternative of testCase.acceptableAlternatives) expect(alternative).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(results[0]).toMatchObject({ score: expect.any(Number), matchReasons: expect.any(Array) });
    });
  }
});
