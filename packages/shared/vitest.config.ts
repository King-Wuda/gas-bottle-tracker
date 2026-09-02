import { defineConfig } from 'vitest/config';

/**
 * Pin the zone before anything reads it. `formatBatchDate` renders in the *viewer's*
 * local time by design, so its test would otherwise assert a different clock time on a
 * machine set to Johannesburg than on a CI box set to UTC — a real failure that says
 * nothing about the code. Workers inherit process.env, so setting it here is enough.
 */
process.env.TZ = 'UTC';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
  },
});
