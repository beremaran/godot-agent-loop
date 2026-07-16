// @test-kind: contract
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CORE_TOOL_NAMES,
  TOOL_SURFACE_BUDGETS,
  advertisedToolDefinitions,
  compactToolSurfaceBytes,
  estimatedToolSurfaceTokens,
} from '../src/tool-surface.js';
import { repoRoot } from './helpers/manifest-sources.js';

const evidence = JSON.parse(readFileSync(
  join(repoRoot, 'docs/coverage/core-budget-revision.json'), 'utf8',
)) as {
  infeasibilityEvidence: {
    actualBytesWithRequiredContractsGuidanceAndAnnotations: number;
    actualEstimatedTokens: number;
  };
  membershipRevision: {
    previousTools: number;
    currentTools: number;
    added: string[];
    removed: string[];
    netChange: number;
  };
  discoveryEvidence: {
    historicalQueries: number;
    historicalPassingQueries: number;
    rankedCorpusCases: number;
    rankedCorpusPassingCases: number;
  };
  reviewedBudget: { coreBytesMax: number; coreEstimatedTokensMax: number };
};
const baseline = JSON.parse(readFileSync(
  join(repoRoot, 'docs/coverage/discovery-prechange-baseline.json'), 'utf8',
)) as { queries: { passed: boolean }[] };
const corpus = JSON.parse(readFileSync(
  join(repoRoot, 'tests/fixtures/discovery-intents.json'), 'utf8',
)) as { cases: unknown[] };

describe('reviewed core budget revision evidence', () => {
  it('matches exact measured size, membership, budgets, and discovery denominators', () => {
    const core = advertisedToolDefinitions('core');
    const bytes = compactToolSurfaceBytes(core);
    const tokens = estimatedToolSurfaceTokens(core);
    expect(bytes).toBe(evidence.infeasibilityEvidence.actualBytesWithRequiredContractsGuidanceAndAnnotations);
    expect(tokens).toBe(evidence.infeasibilityEvidence.actualEstimatedTokens);
    expect(TOOL_SURFACE_BUDGETS).toMatchObject(evidence.reviewedBudget);
    expect(core).toHaveLength(evidence.membershipRevision.currentTools);
    expect(evidence.membershipRevision.currentTools - evidence.membershipRevision.previousTools)
      .toBe(evidence.membershipRevision.netChange);
    for (const name of evidence.membershipRevision.added) expect(CORE_TOOL_NAMES.has(name as never), name).toBe(true);
    for (const name of evidence.membershipRevision.removed) expect(CORE_TOOL_NAMES.has(name as never), name).toBe(false);
    expect(baseline.queries).toHaveLength(evidence.discoveryEvidence.historicalQueries);
    expect(baseline.queries.filter(query => query.passed)).toHaveLength(evidence.discoveryEvidence.historicalPassingQueries);
    expect(corpus.cases).toHaveLength(evidence.discoveryEvidence.rankedCorpusCases);
    expect(evidence.discoveryEvidence.rankedCorpusPassingCases).toBe(corpus.cases.length);
  });
});
