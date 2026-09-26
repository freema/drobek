import { defineConfig } from 'vitest/config';

// template/ holds the scaffold's own tests (run inside a generated module,
// not here). The package test packs @drobek/modules and runs a generated
// module's tests against the tarball (a few tens of seconds).
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], testTimeout: 240_000, hookTimeout: 240_000 },
});
