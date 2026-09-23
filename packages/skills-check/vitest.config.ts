import { defineConfig } from 'vitest/config';

// The examples suite builds the SDK, compiles every skill example with esbuild
// and typechecks them all in ONE TypeScript program (a few seconds).
export default defineConfig({
  test: { testTimeout: 60_000, hookTimeout: 60_000 },
});
