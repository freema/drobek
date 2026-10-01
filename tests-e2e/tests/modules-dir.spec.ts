import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { hostRequest, previewHost, urlOf, type Raw } from './helpers/apps-host';
import { pollLoginCode, skipUnlessLocal } from './helpers/auth';
import { callTool, mcpClient } from './helpers/mcp';
import { personalWorkspaceOf, withDb } from './helpers/seed';

/**
 * The module list of /healthz and /api/version, and a
 * module installed into DROBEK_MODULES_DIR the way an operator installs one.
 *
 * Both stacks list hello,auth,email,forms,data,proxy,files,sync,oidc (server
 * dependencies, `source: builtin`) and the external example module
 * examples/drobek-module-acme-crm: never a server dependency, packed and
 * installed before the stack starts (dev: `task module:example` → ./.modules;
 * image: scripts/e2e-image.sh → `task selfhost:module:add` over the
 * modules_data volume), so `source: dir`.
 *
 *  - a byte changed in the installed module → the loader (loadModules in the
 *    drobek container, DROBEK_MODULES_UNLOCKED unset) refuses it with the
 *    integrity message; reinstalling (E2E_MODULE_REINSTALL, set by both
 *    flows) makes it load again;
 *  - its migration ran under its own journal `__drizzle_migrations_mod_acmecrm`;
 *  - its route answers its own error code `crm_duplicate` in the module
 *    error shape — the dir module's `ModuleError` is recognised, so the
 *    host-provided `@drobek/modules` peer and its brand work; the address
 *    came in through the module's `auth.signedIn` observer.
 */
const BUILTIN = ['hello', 'auth', 'email', 'forms', 'data', 'proxy', 'files', 'sync', 'oidc'];
const EXTERNAL = 'acmecrm';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKAGE_DIR = `/data/modules/${EXTERNAL}/node_modules/drobek-module-acme-crm`;

/** A shell command inside the drobek container of THIS compose project (stdout + stderr). */
function inDrobek(cmd: string): string {
  return execSync(`docker compose exec -T drobek sh -c ${JSON.stringify(`${cmd} 2>&1`)}`, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

/** loadModules(process.env) in the container, exactly as the server loads them at start (never unlocked). */
function loaderVerdict(): string {
  const script = `import('@drobek/modules').then((m) => m.loadModules(process.env)).then((mods) => console.log('LOADED ' + mods.map((x) => x.name).join(',')), (e) => console.log('REFUSED ' + e.message))`;
  return inDrobek(`cd apps/server 2>/dev/null; DROBEK_MODULES_UNLOCKED= node -e ${JSON.stringify(script)}`);
}

test('healthz and api/version list the active modules in DROBEK_MODULES order, the installed one as source dir, without paths @local', async ({ request }) => {
  skipUnlessLocal();
  const health = await (await request.get('/healthz')).json();
  const version = await (await request.get('/api/version')).json();
  const names = (health.modules as { name: string }[]).map((m) => m.name);
  expect(names.filter((n) => [...BUILTIN, EXTERNAL].includes(n))).toEqual([...BUILTIN, EXTERNAL]);
  expect(version.modules).toEqual(health.modules);
  for (const m of health.modules as { name: string; version: string; source: string; contract: string | null }[]) {
    expect(m.version).toMatch(/^\d+\.\d+\.\d+/);
    if (BUILTIN.includes(m.name)) {
      expect(m.source).toBe('builtin');
      // sync runs app jobs (contract 1.2); the others need 1.1.
      expect(m.contract).toBe(m.name === 'sync' ? '^1.2' : '^1.1');
    }
  }
  expect(health.modules).toContainEqual({ name: EXTERNAL, version: '0.1.0', source: 'dir', contract: '^1.2' });
  expect(JSON.stringify(health)).not.toContain('/data/modules');
});

test('a changed byte in the installed module fails its integrity check; reinstalling loads it again @local', async () => {
  skipUnlessLocal();
  test.setTimeout(240_000);
  expect(loaderVerdict()).toMatch(new RegExp(`^LOADED .*\\b${EXTERNAL}\\b`, 'm'));
  inDrobek(`printf ' ' >> ${PACKAGE_DIR}/README.md`);
  const refused = loaderVerdict();
  expect(refused).toContain('REFUSED');
  expect(refused).toContain('does not match its integrity in /data/modules/modules.lock.json (files changed after the install)');
  execSync(process.env.E2E_MODULE_REINSTALL ?? 'task module:example:install', { cwd: repoRoot, stdio: 'pipe' });
  expect(loaderVerdict()).toMatch(new RegExp(`^LOADED .*\\b${EXTERNAL}\\b`, 'm'));
});

test('the installed module migrated its own table under its own journal @local', async () => {
  skipUnlessLocal();
  const r = await withDb((c) =>
    c.query(`SELECT (SELECT count(*)::int FROM drizzle.__drizzle_migrations_mod_acmecrm) AS applied,
                    to_regclass('public.mod_acmecrm_contacts')::text AS tbl`)
  );
  expect(r.rows[0]).toEqual({ applied: 1, tbl: 'mod_acmecrm_contacts' });
});

function sdkHeaders(host: string, cookie?: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Origin: urlOf(host), 'X-Drobek-SDK': '1', ...(cookie ? { Cookie: cookie } : {}) };
}

async function endUserSignIn(request: APIRequestContext, host: string, email: string): Promise<string> {
  const post = (path: string, body: unknown): Promise<Raw> =>
    hostRequest(host, `/__drobek/v1/auth${path}`, { method: 'POST', headers: sdkHeaders(host), body: JSON.stringify(body) });
  const sent = await post('/send-code', { email });
  expect(sent.status, sent.body).toBe(200);
  const verified = await post('/verify', { email, code: await pollLoginCode(request, email) });
  expect(verified.status, verified.body).toBe(200);
  const sc = verified.headers['set-cookie'];
  const cookie = /((?:__Host-)?drobek_eu=[0-9a-f]{64})/.exec((Array.isArray(sc) ? sc : [sc ?? '']).join('\n'));
  expect(cookie, 'session cookie').toBeTruthy();
  return cookie![1];
}

test('its route answers its own crm_duplicate in the module error shape; the auth.signedIn observer wrote the contact @local', async ({ page, request }) => {
  skipUnlessLocal();
  const mcp = await mcpClient(page, request, { tag: 'acmecrm-dir' });
  try {
    const created = await callTool(mcp.client, 'create_app', { name: 'Acme CRM probe', template: 'html' });
    expect(created.isError, created.text).toBe(false);
    const app = created.json as unknown as { app_id: string; slug: string };
    const ws = await personalWorkspaceOf(mcp.email);
    await withDb((c) => c.query(`INSERT INTO workspace_modules (workspace_id, module) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [ws.id, EXTERNAL]));
    const email = `e2e-crm-${Date.now()}@example.com`;
    const auth = await callTool(mcp.client, 'configure_module', { app_id: app.app_id, module: 'auth', config: { allow: { emails: [email] } } });
    expect(auth.isError, auth.text).toBe(false);

    const host = previewHost(app.slug);
    const anon = await hostRequest(host, `/__drobek/v1/${EXTERNAL}/`);
    expect(anon.status).toBe(401);
    const cookie = await endUserSignIn(request, host, email);

    // The observer runs after the session exists and never blocks the sign-in.
    await expect
      .poll(async () => {
        const r = await hostRequest(host, `/__drobek/v1/${EXTERNAL}/`, { headers: { Cookie: cookie } });
        return (JSON.parse(r.body) as { contacts?: { email: string; source: string }[] }).contacts ?? [];
      })
      .toEqual([expect.objectContaining({ email, source: 'sign-in' })]);

    const dup = await hostRequest(host, `/__drobek/v1/${EXTERNAL}/`, {
      method: 'POST',
      headers: sdkHeaders(host, cookie),
      body: JSON.stringify({ email: email.toUpperCase() }),
    });
    expect(dup.status, dup.body).toBe(409);
    expect(dup.headers['content-type']).toContain('application/json');
    const body = JSON.parse(dup.body) as Record<string, unknown>;
    expect(body).toEqual({ error: 'crm_duplicate', message: expect.stringContaining(email), details: { email }, hint: `skill_info('${EXTERNAL}')` });

    const added = await hostRequest(host, `/__drobek/v1/${EXTERNAL}/`, {
      method: 'POST',
      headers: sdkHeaders(host, cookie),
      body: JSON.stringify({ email: `other-${email}`, name: 'Other' }),
    });
    expect(added.status, added.body).toBe(200);
    expect(JSON.parse(added.body)).toMatchObject({ email: `other-${email}`, source: 'app' });
  } finally {
    await mcp.client.close();
  }
});
