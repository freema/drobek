import { defineConfig } from 'vitest/config';

// The suite boots an in-memory PGlite and replays the core migrations.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
});
