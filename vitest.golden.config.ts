import { defineConfig } from 'vitest/config';

/**
 * Deterministic golden-agent acceptance gate: the cold-agent game build replay
 * against a real Godot engine. Kept out of the default `npm run test:e2e` run
 * so ordinary pull requests get the fast representative path; CI invokes it on
 * the Monday schedule, on release tag pushes, and on explicit workflow
 * dispatch, plus the Sunday full compatibility pass. See
 * docs/golden-agent-acceptance.md for the execution policy.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/golden-agent-game.test.ts'],
    // Logs per-file startup counters and prints a run summary (wall clock and
    // MCP/Godot startup counts) so CI can compare infrastructure overhead.
    setupFiles: ['tests/e2e/helpers/e2e-setup.ts'],
    reporters: ['default', 'tests/e2e/helpers/e2e-metrics-reporter.ts'],
    // Real engine processes: generous timeouts, and one file at a time so
    // process/port bookkeeping stays deterministic.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
