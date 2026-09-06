import { defineConfig } from 'vitest/config';

/**
 * Full MCP-to-Godot end-to-end suites: a real MCP client drives the built
 * build/index.js server over stdio against a real Godot engine. Run with
 * `npm run test:e2e` after a build; requires a Godot binary resolvable via
 * GODOT_BIN, PATH, or a GODOT_PATH directory.
 *
 * Each run gets an isolated free runtime port from the harness
 * (`tests/e2e/helpers/harness.ts`); parallel runs never share the literal
 * default 9090, and every concurrently running Godot/MCP instance must use a
 * distinct port. An explicit GODOT_MCP_RUNTIME_PORT override (per-run
 * extraEnv wins over the ambient environment) is validated before any
 * process spawns, and an occupied selected port fails run_project fast with
 * a port-ownership diagnostic instead of connecting to the unrelated owner.
 *
 * The retained suite covers the representative full path, editor discovery,
 * adapter forwarding, and cross-platform startup.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
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
