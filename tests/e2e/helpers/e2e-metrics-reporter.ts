import type { Reporter, TestModule, TestRunEndReason, UserConsoleLog } from 'vitest';
import type { E2EMetrics } from './e2e-metrics.js';

/**
 * E2E infrastructure reporter: aggregates the per-file startup counters logged
 * by helpers/e2e-setup.ts and prints a wall-clock + startup-count summary when
 * the run ends. The counts let CI compare process startup overhead before and
 * after fixture changes (fewer MCP server starts and project creations for the
 * same suite is a direct, measurable win).
 */

const METRICS_PREFIX = '[e2e-metrics]';

export default class E2EMetricsReporter implements Reporter {
  private startedAt = 0;
  private readonly totals: E2EMetrics = { mcpServerStarts: 0, projectsCreated: 0, gameLaunches: 0, gameStops: 0 };
  private fileTally = 0;

  onTestRunStart(): void {
    this.startedAt = Date.now();
  }

  onUserConsoleLog(log: UserConsoleLog): void {
    if (!log.content.startsWith(METRICS_PREFIX)) return;
    this.fileTally += 1;
    const entries = log.content.slice(METRICS_PREFIX.length).trim().split(/\s+/);
    for (const entry of entries) {
      const [key, value] = entry.split('=');
      if (key in this.totals) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) this.totals[key as keyof E2EMetrics] += numeric;
      }
    }
  }

  onTestRunEnd(testModules: readonly TestModule[], _unhandledErrors: unknown[], reason: TestRunEndReason): void {
    const wallMs = Date.now() - this.startedAt;
    const longest = [...testModules]
      .filter(module => Number.isFinite(module.duration))
      .map(module => ({ file: basename(module.moduleId), ms: Math.round(module.duration) }))
      .sort((left, right) => right.ms - left.ms)
      .slice(0, 10);
    const suiteMs = testModules.reduce((total, module) => total + (Number.isFinite(module.duration) ? module.duration : 0), 0);
    const timed = testModules.filter(module => Number.isFinite(module.duration)).length;
    console.log(`\n[e2e-metrics] run finished: ${reason}`);
    console.log(`[e2e-metrics] wall clock: ${formatMs(wallMs)} across ${testModules.length} files (${this.fileTally} tallies)`);
    console.log(`[e2e-metrics] suite timings: ${formatMs(suiteMs)} (${timed}/${testModules.length} files timed)`);
    console.log('[e2e-metrics] startup counts:', JSON.stringify(this.totals));
    if (longest.length > 0) {
      console.log('[e2e-metrics] slowest files:');
      for (const entry of longest) {
        console.log(`[e2e-metrics]   ${formatMs(entry.ms).padStart(10)}  ${entry.file}`);
      }
    }
  }
}

function basename(moduleId: string): string {
  const parts = moduleId.split('/');
  return parts.at(-1) ?? moduleId;
}

function formatMs(milliseconds: number): string {
  if (milliseconds >= 60_000) return `${(milliseconds / 60_000).toFixed(1)}m ${Math.round(milliseconds % 60_000 / 1_000)}s`;
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}
