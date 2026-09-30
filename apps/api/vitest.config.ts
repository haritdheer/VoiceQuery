import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each file gets its own PGlite instance and DuckDB handles; running them
    // in separate forks keeps that isolation and avoids native-handle sharing.
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
    testTimeout: 60_000,
    hookTimeout: 120_000,
    include: ['tests/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      // Demo mode is free by default (it makes no provider call). The suite
      // turns charging on so the credit, refund and idempotency paths are
      // exercised end to end without needing AI credentials. The default
      // itself is covered directly in credits.test.ts → "demo mode cost".
      DEMO_CONSUMES_CREDITS: 'true',
    },
  },
});
