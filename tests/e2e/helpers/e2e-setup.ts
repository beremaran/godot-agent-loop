import { afterAll } from 'vitest';
import { e2eMetrics } from './e2e-metrics.js';

/**
 * Runs in every E2E test file (vitest setupFiles). After the file's own
 * afterAll hooks have closed servers, report this worker's startup counters on
 * a stable prefix that the E2E metrics reporter aggregates across files.
 */
afterAll(() => {
  console.log(
    `[e2e-metrics] mcpServerStarts=${e2eMetrics.mcpServerStarts} `
    + `projectsCreated=${e2eMetrics.projectsCreated} `
    + `gameLaunches=${e2eMetrics.gameLaunches} gameStops=${e2eMetrics.gameStops}`,
  );
});
