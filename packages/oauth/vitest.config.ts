import { defineConfig } from 'vitest/config';

// The DB-backed tests boot an in-memory PGlite and replay the migrations; on a
// busy machine that alone can exceed vitest's 5 s default.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
});
