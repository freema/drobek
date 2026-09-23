import { defineConfig } from 'vitest/config';

// Every test boots an in-memory PGlite and replays the migrations; on a busy
// machine that alone can exceed vitest's 5 s default.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
});
