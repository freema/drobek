import { defineConfig } from 'vitest/config';

// Every suite boots an in-memory PGlite and replays the core + auth migrations.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
});
