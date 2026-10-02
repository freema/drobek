import { expect, test, type Locator, type Page } from '@playwright/test';
import { Redis } from 'ioredis';
import { APPS_DOMAIN, APPS_URL_SCHEME, TARGET_PRODUCTION } from '../playwright.config';
import { directRequest, hostRequest, prodHost, type Raw } from './helpers/apps-host';
import { loginViaEmail, mailpitMessagesFor, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { callTool, mcpClient } from './helpers/mcp';
import { personalWorkspaceOf, publishVersion, seedApp, seedVersion, withDb } from './helpers/seed';
import { tlsAsk } from './helpers/tls-ask';

/**
 * Custom domains, end to end against both local stacks:
 *   - an owner adds a custom domain on the app's Domains tab and gets the DNS
 *     instructions (CNAME → <slug>.<APPS_DOMAIN without port>, TXT
 *     _drobek.<host> = drobek-verify=<token>);
 *   - Verify with missing records → "not verified"; with both records →
 *     verified. The spec writes the records as Redis keys
 *     drobek:dns-mock:<txt|cname>:<name> (JSON string arrays): the dev stack
 *     reads them in process (DOMAINS_DNS_MOCK=redis), the image flow — where
 *     NODE_ENV=production ignores that mock — over real DNS from the e2e
 *     `dns-mock` server (tests-e2e/dns-mock.mjs, DOMAINS_DNS_SERVERS);
 *   - Caddy's ask (GET /api/internal/tls/ask on the internal Host drobek:3000)
 *     → 200 only once verified, 404 before / after;
 *   - the custom Host serves the published version; a primary domain makes the
 *     default host 302 to it;
 *   - the re-check (every 5 s in both e2e stacks, DOMAINS_RECHECK_INTERVAL_MS)
 *     drops a backdated domain whose TXT record vanished and e-mails the
 *     owner (Mailpit);
 *   - a verified name is domain_taken for another workspace's app until its app
 *     is deleted; then the ask says no and the host 404s at once, and the other
 *     app adds and verifies the name and serves on it;
 *   - drobek-owned names → hostname_not_allowed, IP literals → invalid_hostname,
 *     the 4th domain of an app → limit_exceeded (DOMAINS_MAX_PER_APP=3);
 *   - audit rows domain.add / domain.verify / domain.primary / domain.unverify /
 *     domain.remove.
 *   - the same over MCP — list_domains / add_domain / verify_domain /
 *     set_primary_domain / remove_domain, the confirmation gates and the audit
 *     rows as the agent.
 * The ask and the custom host go straight to drobek (DROBEK_URL), the way
 * Caddy forwards them: Caddy itself only serves a custom domain once it has
 * a certificate.
 */

test.describe.configure({ mode: 'serial' });

/** The dev mock also admits the `.test` TLD; production wants a name under a public suffix. */
const HOST = TARGET_PRODUCTION ? 'firma.example.com' : 'firma.test';
/** The custom host with APPS_DOMAIN's port (a custom Host must carry it). */
const APPS_PORT = /:(\d+)$/.exec(APPS_DOMAIN)?.[1] ?? null;
const HOST_WITH_PORT = APPS_PORT ? `${HOST}:${APPS_PORT}` : HOST;

async function redisClient(): Promise<Redis> {
  const url = process.env.REDIS_URL;
  expect(url, 'REDIS_URL (the local stack)').toBeTruthy();
  const r = new Redis(url!, { maxRetriesPerRequest: 2, lazyConnect: true });
  await r.connect();
  return r;
}

async function setMock(type: 'txt' | 'cname' | 'a' | 'aaaa', name: string, values: string[] | null): Promise<void> {
  const r = await redisClient();
  try {
    const key = `drobek:dns-mock:${type}:${name}`;
    if (values === null) await r.del(key);
    else await r.set(key, JSON.stringify(values), 'EX', 3600);
  } finally {
    r.disconnect();
  }
}

async function clearMocks(): Promise<void> {
  const r = await redisClient();
  try {
    const keys = await r.keys(`drobek:dns-mock:*${HOST}`);
    if (keys.length > 0) await r.del(...keys);
  } finally {
    r.disconnect();
  }
}

/** A GET on the custom host as the proxy forwards it (the name resolves nowhere): straight to drobek with that Host header. */
function customGet(path = '/', host = HOST): Promise<Raw> {
  return directRequest(APPS_PORT ? `${host}:${APPS_PORT}` : host, path);
}

function rowOf(page: Page, hostname: string): Locator {
  return page.locator(`[data-testid="domain-row"][data-hostname="${hostname}"]`);
}

async function addDomain(page: Page, hostname: string): Promise<void> {
  await page.getByTestId('domain-input').fill(hostname);
  await page.getByTestId('domain-add').click();
}

async function expectError(page: Page, code: string): Promise<void> {
  await expect(page.getByTestId('domain-error')).toHaveAttribute('data-code', code);
}

async function domainRow(hostname: string, appId: string): Promise<{ verified_at: Date | null; last_error: string | null } | null> {
  return withDb(async (c) => {
    const res = await c.query(`SELECT verified_at, last_error FROM domains WHERE hostname = $1 AND app_id = $2`, [hostname, appId]);
    return (res.rows[0] as { verified_at: Date | null; last_error: string | null } | undefined) ?? null;
  });
}

async function seedPublishedApp(email: string, marker: string): Promise<{ id: string; slug: string; ws: string }> {
  const ws = await personalWorkspaceOf(email);
  const app = await seedApp({ workspaceId: ws.id });
  const v = await seedVersion({
    appId: app.id,
    files: [{ path: 'index.html', content: `<!doctype html><title>${marker}</title><h1>${marker}</h1>` }],
  });
  await publishVersion(app.id, v.id);
  return { ...app, ws: ws.slug };
}

test.describe('custom domains @local', () => {
  test('add → instructions → verify → ask/serve/primary → re-check drops it + mails the owner → remove', async ({
    page,
    request,
  }) => {
    skipUnlessLocal();
    test.setTimeout(180_000);

    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

    // Leftovers of an earlier run: the hostname is fixed (it is the fixture's).
    await withDb((c) => c.query(`DELETE FROM domains WHERE hostname = $1 OR hostname LIKE $2`, [HOST, `%.${HOST}`]));
    await clearMocks();

    const email = uniqueEmail('domains');
    await loginViaEmail(page, request, email);
    const marker = `e2e-domains-${Date.now()}`;
    const app = await seedPublishedApp(email, marker);
    const domainsUrl = `/workspaces/${app.ws}/apps/${app.slug}/domains`;
    const cnameTarget = `${app.slug}.${APPS_DOMAIN.replace(/:\d+$/, '')}`;

    await test.step('the app page links the Domains tab', async () => {
      await page.goto(`/workspaces/${app.ws}/apps/${app.slug}`);
      await page.locator('[data-testid="app-tab"][data-tab="domains"]').click();
      await page.waitForURL((u) => u.pathname === domainsUrl);
      await expect(page.getByTestId('domains-empty')).toBeVisible();
    });

    let txtValue = '';
    await test.step('add (normalized to lower case) → not verified + the DNS instructions', async () => {
      await addDomain(page, HOST.toUpperCase());
      await expect(page.getByTestId('domain-notice')).toContainText(HOST);
      const row = rowOf(page, HOST);
      await expect(row).toHaveAttribute('data-verified', 'false');
      await expect(row.getByTestId('domain-status')).toHaveText('not verified');
      await expect(row.getByTestId('cname-name')).toHaveText(HOST);
      await expect(row.getByTestId('cname-value')).toHaveText(cnameTarget);
      await expect(row.getByTestId('txt-name')).toHaveText(`_drobek.${HOST}`);
      txtValue = (await row.getByTestId('txt-value').textContent())?.trim() ?? '';
      expect(txtValue).toMatch(/^drobek-verify=[0-9a-f]{32}$/);

      // the same name twice → already_added
      await addDomain(page, HOST);
      await expectError(page, 'already_added');
    });

    await test.step('unverified: no certificate, the custom host answers 404 (never the dashboard)', async () => {
      expect(await tlsAsk(HOST)).toBe(404);
      const res = await customGet('/');
      expect(res.status).toBe(404);
      expect(res.body).not.toContain(marker);
    });

    await test.step('verify without records → not verified; CNAME only → still not verified', async () => {
      const row = rowOf(page, HOST);
      await row.getByTestId('domain-verify').click();
      await expectError(page, 'not_verified');
      await expect(row).toHaveAttribute('data-verified', 'false');

      await setMock('cname', HOST, [cnameTarget]);
      await row.getByTestId('domain-verify').click();
      await expectError(page, 'not_verified');
      await expect(page.getByTestId('domain-error')).toContainText('TXT record');
      await expect(page.getByTestId('domain-error')).not.toContainText('CNAME record');
      await expect(row).toHaveAttribute('data-verified', 'false');
    });

    await test.step('TXT + CNAME → verified', async () => {
      await setMock('txt', `_drobek.${HOST}`, [txtValue]);
      const row = rowOf(page, HOST);
      await row.getByTestId('domain-verify').click();
      await expect(page.getByTestId('domain-notice')).toContainText('verified');
      await expect(row).toHaveAttribute('data-verified', 'true');
      await expect(row.getByTestId('domain-status')).toHaveText('verified');
      await expect(row.getByTestId('domain-instructions')).toHaveCount(0);
    });

    await test.step('verified: the ask says yes, the custom host serves the published version', async () => {
      expect(await tlsAsk(HOST)).toBe(200);
      expect(await tlsAsk(`unknown-e2e.${HOST}`)).toBe(404);
      await expect
        .poll(async () => (await customGet('/')).status, { timeout: 15_000 })
        .toBe(200);
      const res = await customGet('/');
      expect(res.body).toContain(marker);
      expect(res.headers['x-robots-tag']).toBeUndefined();
    });

    await test.step('primary: the default host 302s to the custom domain; stop redirecting', async () => {
      const row = rowOf(page, HOST);
      await row.getByTestId('domain-make-primary').click();
      await expect(row.getByTestId('domain-primary')).toBeVisible();
      await expect
        .poll(async () => (await hostRequest(prodHost(app.slug), '/about?x=1')).status, { timeout: 15_000 })
        .toBe(302);
      const moved = await hostRequest(prodHost(app.slug), '/about?x=1');
      expect(moved.headers.location).toBe(`${APPS_URL_SCHEME}://${HOST_WITH_PORT}/about?x=1`);

      await row.getByTestId('domain-unprimary').click();
      await expect(row.getByTestId('domain-primary')).toHaveCount(0);
      await expect
        .poll(async () => (await hostRequest(prodHost(app.slug), '/')).status, { timeout: 15_000 })
        .toBe(200);
    });

    await test.step('the daily re-check drops a domain whose TXT record vanished and mails the owner', async () => {
      await setMock('txt', `_drobek.${HOST}`, null);
      await withDb((c) =>
        c.query(`UPDATE domains SET last_check_at = now() - interval '25 hours' WHERE hostname = $1 AND app_id = $2`, [
          HOST,
          app.id,
        ])
      );
      await expect
        .poll(
          async () => {
            const row = await domainRow(HOST, app.id);
            return row ? row.verified_at : 'no row';
          },
          {
            timeout: 45_000,
            intervals: [1_000],
          }
        )
        .toBeNull();
      expect((await domainRow(HOST, app.id))?.last_error).toBeTruthy();

      await expect
        .poll(
          async () =>
            (await mailpitMessagesFor(request, email.toLowerCase())).filter((m) =>
              (m.Subject ?? '').includes(`${HOST} is no longer verified`)
            ).length,
          { timeout: 30_000 }
        )
        .toBe(1);

      expect(await tlsAsk(HOST)).toBe(404);
      await expect
        .poll(async () => (await customGet('/')).status, { timeout: 15_000 })
        .toBe(404);

      await page.reload();
      const row = rowOf(page, HOST);
      await expect(row).toHaveAttribute('data-verified', 'false');
      await expect(row.getByTestId('domain-last-error')).toBeVisible();
      await expect(row.getByTestId('domain-instructions')).toBeVisible();
    });

    await test.step('remove (confirmed) → the row is gone', async () => {
      page.once('dialog', (d) => void d.accept());
      await rowOf(page, HOST).getByTestId('domain-remove').click();
      await expect(rowOf(page, HOST)).toHaveCount(0);
      await expect(page.getByTestId('domains-empty')).toBeVisible();
      expect(await domainRow(HOST, app.id)).toBeNull();
    });

    await test.step('every change is audited', async () => {
      const actions = await withDb(async (c) => {
        const res = await c.query(
          `SELECT action FROM audit_log WHERE subject_type = 'domain' AND meta->>'app_id' = $1 ORDER BY created_at`,
          [app.id]
        );
        return res.rows.map((r) => r.action as string);
      });
      expect(actions).toEqual(
        expect.arrayContaining(['domain.add', 'domain.verify', 'domain.primary', 'domain.unverify', 'domain.remove'])
      );
      expect(actions[0]).toBe('domain.add');
      expect(actions[actions.length - 1]).toBe('domain.remove');
    });

    await clearMocks();
    expect(problems).toEqual([]);
  });

  test('a deleted app frees its domain: an app of another workspace adds and verifies it, the ask and the host follow', async ({
    page,
    request,
    browser,
  }) => {
    skipUnlessLocal();
    test.setTimeout(180_000);

    const name = `reuse-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    const host = TARGET_PRODUCTION ? `${name}.example.com` : `${name}.test`;
    const cnameOf = (slug: string) => `${slug}.${APPS_DOMAIN.replace(/:\d+$/, '')}`;
    const verifyOn = async (p: Page, slug: string) => {
      const row = rowOf(p, host);
      await expect(row).toHaveAttribute('data-verified', 'false');
      const txt = (await row.getByTestId('txt-value').textContent())?.trim() ?? '';
      expect(txt).toMatch(/^drobek-verify=[0-9a-f]{32}$/);
      await setMock('txt', `_drobek.${host}`, [txt]);
      await setMock('cname', host, [cnameOf(slug)]);
      await row.getByTestId('domain-verify').click();
      await expect(row).toHaveAttribute('data-verified', 'true');
    };

    const emailA = uniqueEmail('domains-reuse-a');
    await loginViaEmail(page, request, emailA);
    const markerA = `e2e-domains-reuse-a-${Date.now()}`;
    const first = await seedPublishedApp(emailA, markerA);

    const otherCtx = await browser.newContext();
    try {
      const other = await otherCtx.newPage();
      const emailB = uniqueEmail('domains-reuse-b');
      await loginViaEmail(other, request, emailB);
      const markerB = `e2e-domains-reuse-b-${Date.now()}`;
      const second = await seedPublishedApp(emailB, markerB);
      expect(second.ws).not.toBe(first.ws);

      await test.step('the first app verifies the name and serves on it', async () => {
        await page.goto(`/workspaces/${first.ws}/apps/${first.slug}/domains`);
        await addDomain(page, host);
        await verifyOn(page, first.slug);
        expect(await tlsAsk(host)).toBe(200);
        await expect.poll(async () => (await customGet('/', host)).body.includes(markerA), { timeout: 15_000 }).toBe(true);
      });

      await test.step('while that app lives, another workspace cannot add the name (domain_taken)', async () => {
        await other.goto(`/workspaces/${second.ws}/apps/${second.slug}/domains`);
        await addDomain(other, host);
        await expectError(other, 'domain_taken');
        await expect(rowOf(other, host)).toHaveCount(0);
      });

      await test.step('deleting the app stops the name at once: no certificate, 404 on the host', async () => {
        await page.goto(`/workspaces/${first.ws}/apps/${first.slug}/settings`);
        await page.getByTestId('delete-confirm-input').fill(first.slug);
        await page.getByTestId('delete-button').click();
        await page.waitForURL(new RegExp(`/workspaces/${first.ws}/apps\\?deleted=${first.slug}$`));
        expect(await tlsAsk(host)).toBe(404);
        await expect.poll(async () => (await customGet('/', host)).status, { timeout: 15_000 }).toBe(404);
      });

      await test.step('the app of the other workspace now adds and verifies the same name', async () => {
        await other.goto(`/workspaces/${second.ws}/apps/${second.slug}/domains`);
        await addDomain(other, host);
        await expect(other.getByTestId('domain-notice')).toContainText(host);
        await verifyOn(other, second.slug);
        expect(await tlsAsk(host)).toBe(200);
        await expect.poll(async () => (await customGet('/', host)).body.includes(markerB), { timeout: 15_000 }).toBe(true);
        expect((await domainRow(host, first.id))?.verified_at).toBeNull();
        expect((await domainRow(host, second.id))?.verified_at).not.toBeNull();
      });
    } finally {
      await otherCtx.close();
      await setMock('txt', `_drobek.${host}`, null);
      await setMock('cname', host, null);
      await withDb((c) => c.query(`DELETE FROM domains WHERE hostname = $1`, [host]));
    }
  });

  test('refused names and the per-app limit (no DNS involved)', async ({ page, request }) => {
    skipUnlessLocal();

    const email = uniqueEmail('domains-limit');
    await loginViaEmail(page, request, email);
    const app = await seedPublishedApp(email, `e2e-domains-limit-${Date.now()}`);
    await page.goto(`/workspaces/${app.ws}/apps/${app.slug}/domains`);

    await addDomain(page, 'www.drobek.app');
    await expectError(page, 'hostname_not_allowed');
    await addDomain(page, `x.${APPS_DOMAIN.replace(/:\d+$/, '')}`);
    await expectError(page, 'hostname_not_allowed');
    await addDomain(page, '203.0.113.7');
    await expectError(page, 'invalid_hostname');
    await addDomain(page, 'co.uk');
    await expectError(page, 'hostname_not_allowed');
    await expect(page.getByTestId('domains-empty')).toBeVisible();

    // example.com is a real, PSL-listed name: fine in both the dev and the image flow.
    const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    for (const n of [1, 2, 3]) {
      const name = `e2e-${tag}-${n}.example.com`;
      await addDomain(page, name);
      await expect(rowOf(page, name)).toHaveCount(1);
    }
    await addDomain(page, `e2e-${tag}-4.example.com`);
    await expectError(page, 'limit_exceeded');
    await expect(page.locator('[data-testid="domain-row"]')).toHaveCount(3);

    const added = await withDb(async (c) => {
      const res = await c.query(
        `SELECT count(*)::int AS n FROM audit_log WHERE action = 'domain.add' AND meta->>'app_id' = $1`,
        [app.id]
      );
      return res.rows[0].n as number;
    });
    expect(added).toBe(3);

    await withDb((c) => c.query(`DELETE FROM domains WHERE app_id = $1`, [app.id]));
  });

  test('over MCP: list → add → verify (what is missing) → primary + remove with the user\'s yes, audited as the agent', async ({
    page,
    request,
  }) => {
    skipUnlessLocal();
    test.setTimeout(120_000);
    const mcp = await mcpClient(page, request, { tag: 'domains-mcp' });
    try {
      const app = await seedPublishedApp(mcp.email, `e2e-domains-mcp-${Date.now()}`);
      const cnameTarget = `${app.slug}.${APPS_DOMAIN.replace(/:\d+$/, '')}`;
      const call = (name: string, args: Record<string, unknown>) => callTool(mcp.client, name, { app_id: app.id, ...args });

      const empty = await call('list_domains', {});
      expect(empty.isError, empty.text).toBe(false);
      expect(empty.json).toMatchObject({ app_id: app.id, cname_target: cnameTarget, domains: [] });

      const refused = await call('add_domain', { host: 'www.drobek.app' });
      expect(refused.isError).toBe(true);
      expect(refused.json).toMatchObject({ code: 'hostname_not_allowed' });

      // The dev mock admits the .test TLD; the image flow uses a real, PSL-listed name.
      const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
      const host = TARGET_PRODUCTION ? `e2e-mcp-${tag}.example.com` : `mcp-${tag}.test`;

      const added = await call('add_domain', { host: host.toUpperCase() });
      expect(added.isError, added.text).toBe(false);
      const domain = added.json.domain as { host: string; status: string; records: { cname: { name: string; value: string }; txt: { name: string; value: string } } };
      expect(domain).toMatchObject({ host, status: 'pending', records: { cname: { name: host, value: cnameTarget }, txt: { name: `_drobek.${host}` } } });
      expect(domain.records.txt.value).toMatch(/^drobek-verify=[0-9a-f]{32}$/);
      const dup = await call('add_domain', { host });
      expect(dup.json).toMatchObject({ code: 'domain_already_added' });
      const listed = await call('list_domains', {});
      expect((listed.json.domains as { host: string }[]).map((d) => d.host)).toEqual([host]);

      const none = await call('verify_domain', { host });
      expect(none.isError).toBe(true);
      expect(none.json).toMatchObject({ code: 'domain_not_verified', cname: 'missing', txt: 'missing' });

      await setMock('txt', domain.records.txt.name, [domain.records.txt.value]);
      const onlyTxt = await call('verify_domain', { host });
      expect(onlyTxt.json).toMatchObject({ code: 'domain_not_verified', cname: 'missing', txt: 'ok' });
      expect(String(onlyTxt.json.message)).toContain(`CNAME ${host}`);

      await setMock('cname', host, [cnameTarget]);
      const verified = await call('verify_domain', { host });
      expect(verified.isError, verified.text).toBe(false);
      expect(verified.json).toMatchObject({ newly_verified: true, domain: { host, status: 'verified' } });

      const ask = await call('set_primary_domain', { host });
      expect(ask.json).toMatchObject({ code: 'user_confirmation_required' });
      const primary = await call('set_primary_domain', { host, user_confirmed: true });
      expect(primary.isError, primary.text).toBe(false);
      expect(primary.json).toMatchObject({ primary: host });

      const askRemove = await call('remove_domain', { host });
      expect(askRemove.json).toMatchObject({ code: 'user_confirmation_required', primary: true });
      const removed = await call('remove_domain', { host, user_confirmed: true });
      expect(removed.json).toMatchObject({ removed: host, was_verified: true, was_primary: true });
      await setMock('txt', domain.records.txt.name, null);
      await setMock('cname', host, null);
      const after = await call('list_domains', {});
      expect(after.json.domains).toEqual([]);

      const rows = await withDb(async (c) => {
        const res = await c.query(`SELECT action, actor_kind FROM audit_log WHERE target = $1 ORDER BY created_at`, [host]);
        return res.rows as { action: string; actor_kind: string }[];
      });
      expect(rows.map((r) => r.action)).toEqual(['domain.add', 'domain.verify', 'domain.primary', 'domain.remove']);
      expect(rows.every((r) => r.actor_kind === 'agent')).toBe(true);
    } finally {
      await mcp.client.close();
    }
  });
});
