import { defineConfig } from 'vitest/config';

// The route suites boot an in-memory PGlite (core + files migrations) and a temp FILES_DIR.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
});
