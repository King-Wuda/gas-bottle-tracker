import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    globals: false,
    // Run test FILES one at a time in a single reused fork: the serial-allocator
    // concurrency test and the idempotency-replay tests all hit the same Postgres
    // schema, so parallel files would race on truncation. Parallelism WITHIN a file
    // (Promise.all of N requests) — the point of the concurrency test — is unaffected.
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
