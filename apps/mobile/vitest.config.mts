import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the offline core — the outbox store and the sync worker. These are
 * plain TypeScript with no React Native runtime, so they run in node: anything that
 * would pull in a native module is mocked at the module boundary.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
  },
});
