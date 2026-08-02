import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // E2E suites need a built package and a real Godot binary; they run
    // separately through vitest.e2e.config.ts (npm run test:e2e).
    exclude: ['tests/e2e/**', '**/node_modules/**'],
    // Unit tests construct handlers directly with throwaway temp directories
    // and no client roots. That mirrors a legacy open-mode sandbox rather than
    // a real MCP session, so the test environment explicitly opts in to the
    // legacy unrestricted path mode. Production defaults remain secure:
    // without roots and without this opt-in, filesystem access is denied.
    env: { GODOT_MCP_ALLOW_UNRESTRICTED: 'true' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/scripts/**'],
      // Hard gate: `npm run coverage:unit` (part of `npm run check`) fails when
      // exercised line/statement/function coverage drops below these floors.
      // Baselines reflect the unit suite alone; e2e adds engine-side coverage.
      thresholds: {
        statements: 60,
        branches: 40,
        functions: 65,
        lines: 65,
      },
    },
  },
});
