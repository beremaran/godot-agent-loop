import { defineConfig } from 'vitest/config';

/**
 * Full MCP-to-Godot end-to-end suites: a real MCP client drives the built
 * build/index.js server over stdio against a real Godot engine. Run with
 * `npm run test:e2e` after a build; requires a Godot binary resolvable via
 * GODOT_BIN, PATH, or a GODOT_PATH directory.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    // Real engine processes: generous timeouts, and one file at a time so
    // process/port bookkeeping stays deterministic.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
