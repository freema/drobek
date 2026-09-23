import { defineConfig } from '@playwright/test';

/**
 * One suite, two targets, env-parameterized (ROADMAP §4):
 * - BASE_URL_WEB  — web app (default: local compose stack, host port 3041)
 * - BASE_URL_MCP  — MCP endpoint origin (default: same as BASE_URL_WEB — one process)
 * - TEST_ENV      — 'local' unlocks @local specs (destructive / needs the
 *                   local docker compose stack). @smoke specs are safe against
 *                   any target, prod included: public HTTP + MCP only, never
 *                   the database, Redis or Mailpit (the MCP smoke loop signs
 *                   in with SMOKE_API_KEY and only touches `smoke-*` apps).
 * - E2E_TARGET_PRODUCTION=1 — the target runs NODE_ENV=production (the image
 *                   flow, `task e2e:image` / CI): dev-only allowances such as
 *                   OAUTH_CIMD_DEV_ORIGINS are off, so specs assert the refusal.
 * - E2E_IGNORE_HTTPS_ERRORS=1 — the browser + APIRequestContext accept the
 *                   target's local CA (Caddy `tls internal`); Node's own
 *                   clients trust it through NODE_EXTRA_CA_CERTS instead.
 */
export const BASE_URL_WEB =
  process.env.BASE_URL_WEB ?? 'http://localhost:3041';
export const BASE_URL_MCP =
  process.env.BASE_URL_MCP ?? BASE_URL_WEB;
export const TEST_ENV = process.env.TEST_ENV ?? '';
export const TARGET_PRODUCTION = process.env.E2E_TARGET_PRODUCTION === '1';
/**
 * The apps origin the stack hands out (M0-05) — mirrors the server's default:
 * docker-compose sets APPS_DOMAIN=apps.localhost:3041; the scheme is http for
 * localhost / *.localhost unless APPS_URL_SCHEME overrides it.
 */
export const APPS_DOMAIN = process.env.APPS_DOMAIN || 'apps.localhost:3041';
export const APPS_URL_SCHEME =
  process.env.APPS_URL_SCHEME ||
  (/(^|\.)localhost(:\d+)?$/.test(APPS_DOMAIN) ? 'http' : 'https');

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  forbidOnly: Boolean(process.env.CI),
  // CI runs on a cold, shared runner (first sign-in after a fresh boot, NSO-314):
  // one retry there; a retried pass is still reported as flaky. Never locally.
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: BASE_URL_WEB,
    ignoreHTTPSErrors: process.env.E2E_IGNORE_HTTPS_ERRORS === '1',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  reporter: [['list'], ['html', { open: 'never' }]],
  workers: 1,
});
