import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // E2E suites need a built package and a real Godot binary; they run
    // separately through vitest.e2e.config.ts (npm run test:e2e).
    exclude: ['tests/e2e/**', '**/node_modules/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/scripts/**'],
    },
  },
});
