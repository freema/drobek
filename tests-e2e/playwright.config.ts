import { defineConfig } from '@playwright/test';

/**
 * One suite, two targets, env-parameterized (ROADMAP §4):
 * - BASE_URL_WEB  — web app (default: local compose stack, host port 3041)
 * - BASE_URL_MCP  — mcp server (default: host port 3042)
 * - TEST_ENV      — 'local' unlocks @local specs (destructive / needs the
 *                   local docker compose stack). @smoke specs are read-only
 *                   and safe against any target, prod included.
 */
export const BASE_URL_WEB =
  process.env.BASE_URL_WEB ?? 'http://localhost:3041';
export const BASE_URL_MCP =
  process.env.BASE_URL_MCP ?? 'http://localhost:3042';
export const TEST_ENV = process.env.TEST_ENV ?? '';

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: BASE_URL_WEB,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  reporter: [['list'], ['html', { open: 'never' }]],
  workers: 1,
});
