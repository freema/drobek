import { expect, test } from '@playwright/test';
import { skipUnlessLocal } from './helpers/auth';

/**
 * NSO-345: the module list of /healthz and /api/version against the stack's
 * DROBEK_MODULES (dev + e2e image compose: hello,auth,email,forms,data,proxy,
 * files — all server dependencies, so `source: builtin`; the modules
 * directory `/data/modules` is mounted but empty). A module installed into
 * DROBEK_MODULES_DIR shows `source: dir` (the black-box pass installs one).
 */
const STACK_MODULES = ['hello', 'auth', 'email', 'forms', 'data', 'proxy', 'files'];

test('healthz and api/version list the active modules in DROBEK_MODULES order, without paths @local', async ({ request }) => {
  skipUnlessLocal();
  const health = await (await request.get('/healthz')).json();
  const version = await (await request.get('/api/version')).json();
  const names = (health.modules as { name: string }[]).map((m) => m.name);
  expect(names.filter((n) => STACK_MODULES.includes(n))).toEqual(STACK_MODULES);
  expect(version.modules).toEqual(health.modules);
  for (const m of health.modules as { name: string; version: string; source: string; contract: string | null }[]) {
    expect(m.version).toMatch(/^\d+\.\d+\.\d+/);
    if (STACK_MODULES.includes(m.name)) {
      expect(m.source).toBe('builtin');
      expect(m.contract).toBe('^1.1');
    }
  }
  expect(JSON.stringify(health)).not.toContain('/data/modules');
});
