// @test-kind: contract
import { describe, expect, it } from 'vitest';
import { readRepoFile } from './helpers/manifest-sources.js';

interface Sample {
  totalMs: number;
  startupEditMs: number[];
  warmEditMs: number[];
  operationMs: number[];
}

interface LoopLatency {
  schemaVersion: number;
  methodology: { measuredIterationsPerMode: number; warmupIterationsPerMode: number; workload: string[] };
  budgets: Record<string, number>;
  samples: { session: Sample[]; subprocess: Sample[] };
  summary: {
    session: { medianMs: number; p95Ms: number };
    subprocess: { medianMs: number; p95Ms: number };
    sessionStartupP95Ms: number;
    warmSessionCommandP95Ms: number;
    subprocessOperationP95Ms: number;
    sessionToSubprocessMedianRatio: number;
    medianReductionPercent: number;
    warmCommandP95ReductionPercent: number;
  };
  budgetResults: Record<string, boolean>;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

describe('authoring loop latency evidence', () => {
  const latency = JSON.parse(readRepoFile('docs/coverage/loop-latency.json')) as LoopLatency;

  it('records a reproducible fresh-project workload and raw samples', () => {
    expect(latency.schemaVersion).toBe(1);
    expect(latency.methodology.measuredIterationsPerMode).toBeGreaterThanOrEqual(7);
    expect(latency.methodology.warmupIterationsPerMode).toBeGreaterThanOrEqual(1);
    expect(latency.methodology.workload).toEqual(expect.arrayContaining([
      'create_scene', 'launch headed game', 'authenticated get_scene_tree observation',
      'modify_node after observation',
    ]));
    expect(latency.samples.session).toHaveLength(latency.methodology.measuredIterationsPerMode);
    expect(latency.samples.subprocess).toHaveLength(latency.methodology.measuredIterationsPerMode);
    expect(latency.samples.session.every(sample => sample.warmEditMs.length === 3)).toBe(true);
    expect(latency.samples.subprocess.every(sample => sample.operationMs.length === 5)).toBe(true);
  });

  it('derives the published headline from raw monotonic timings', () => {
    const sessionMedian = median(latency.samples.session.map(sample => sample.totalMs));
    const subprocessMedian = median(latency.samples.subprocess.map(sample => sample.totalMs));
    expect(latency.summary.session.medianMs).toBeCloseTo(sessionMedian, 2);
    expect(latency.summary.subprocess.medianMs).toBeCloseTo(subprocessMedian, 2);
    expect(latency.summary.sessionToSubprocessMedianRatio)
      .toBeCloseTo(sessionMedian / subprocessMedian, 3);
    expect(latency.summary.medianReductionPercent).toBeLessThan(0);
    expect(latency.summary.warmSessionCommandP95Ms)
      .toBeLessThan(latency.summary.subprocessOperationP95Ms);
    expect(latency.summary.warmCommandP95ReductionPercent).toBeGreaterThan(0);
  });

  it('publishes passing absolute and relative budgets in the generated report', () => {
    expect(Object.keys(latency.budgets)).toEqual([
      'sessionCycleMedianMaxMs', 'sessionToSubprocessMedianRatioMax',
      'sessionStartupP95MaxMs', 'warmSessionCommandP95MaxMs',
    ]);
    expect(Object.values(latency.budgetResults).every(Boolean)).toBe(true);

    const report = readRepoFile('docs/coverage/coverage-report.md');
    expect(report).toContain('## Authoring loop latency');
    expect(report).toContain(`${latency.summary.session.medianMs.toFixed(2)} ms`);
    expect(report).toContain(`${(-latency.summary.medianReductionPercent).toFixed(1)}% slower`);
    expect(report).toContain(`${latency.summary.warmCommandP95ReductionPercent.toFixed(1)}%`);

    const packageJson = JSON.parse(readRepoFile('package.json')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['benchmark:loop']).toContain('benchmark-authoring-loop.mjs');
  });
});
