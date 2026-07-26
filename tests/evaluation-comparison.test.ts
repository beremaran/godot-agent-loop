// @test-kind: contract
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './helpers/manifest-sources.js';
import { compare, markdown } from '../scripts/compare-evaluation-results.mjs';

describe('paired evaluation comparison', () => {
  it('produces a zero-variance, passing A/A report', () => {
    const source = join(repoRoot, 'evals', 'current-model-status.json');
    const report = compare({
      baseline: source,
      candidate: source,
      expectEquivalent: true,
      bootstrapSamples: 1000,
      seed: 20_260_726,
    });
    expect(report.releaseDecision).toBe('passed');
    expect(report.inputs.pairCount).toBe(9);
    expect(report.controls.aaEquivalent).toBe(true);
    expect(report.controls.bootstrap).toMatchObject({ lower: 0, upper: 0 });
    expect(report.provenance.evaluator).toMatchObject({
      inspectVersion: '0.3.249',
      comparisonImplementation: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      scorerImplementation: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(report.controls.environmentMatrix.baseline.model).toEqual(['gpt-5.6-luna']);
    expect(report.pairs[0]).toMatchObject({
      baselineHardGate: true,
      candidateHardGate: true,
      baselineMetrics: expect.any(Object),
      candidateMetrics: expect.any(Object),
    });
    expect(report.pairs[0].candidateCriteria.every((criterion: { evidenceSha256: string }) =>
      /^[a-f0-9]{64}$/.test(criterion.evidenceSha256))).toBe(true);
    expect(markdown(report)).toContain('Decision: **passed**');
  });

  it('rejects an unpaired or non-identical A/A input', () => {
    expect(() => compare({
      baseline: join(repoRoot, 'evals', 'current-model-status.json'),
      candidate: join(repoRoot, 'evals', 'baselines', 'v1.1.4', 'manifest.json'),
      expectEquivalent: true,
      bootstrapSamples: 100,
      seed: 1,
    })).toThrow(/Unpaired|not byte-for-byte equivalent|runs/);
  });
});
