import { defineConfig } from 'vitest/config';

// checkSkill compiles and typechecks SKILL.md in one TypeScript program (a few seconds).
export default defineConfig({
  test: { testTimeout: 60_000, hookTimeout: 60_000 },
});
