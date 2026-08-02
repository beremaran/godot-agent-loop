import { defineConfig } from 'vitest/config';

/**
 * Full MCP-to-Godot end-to-end suites: a real MCP client drives the built
 * build/index.js server over stdio against a real Godot engine. Run with
 * `npm run test:e2e` after a build; requires a Godot binary resolvable via
 * GODOT_BIN, PATH, or a GODOT_PATH directory.
 *
 * The deterministic golden-agent acceptance gate is deliberately excluded
 * from this default run: pull requests get the fast representative path, and
 * the 120-second gate runs on schedule, release tags, and explicit dispatch
 * via `npm run test:golden-agent` (see vitest.golden.config.ts and
 * docs/golden-agent-acceptance.md).
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['tests/e2e/golden-agent-game.test.ts'],
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
