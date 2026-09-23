import { request as httpRequest } from 'node:http';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { Redis } from 'ioredis';
import { APPS_DOMAIN, APPS_URL_SCHEME, BASE_URL_WEB, TARGET_PRODUCTION } from '../playwright.config';
import { hostRequest, prodHost, type Raw } from './helpers/apps-host';
import { loginViaEmail, mailpitMessagesFor, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { personalWorkspaceOf, publishVersion, seedApp, seedVersion, withDb } from './helpers/seed';

/**
 * M3-01 (NSO-292) acceptance, end to end against the local compose stack:
 *   - an owner adds a custom domain on the app's Domains tab and gets the DNS
 *     instructions (CNAME → <slug>.<APPS_DOMAIN without port>, TXT
 *     _drobek.<host> = drobek-verify=<token>);
 *   - Verify with missing records → "not verified"; with both records →
 *     verified (DNS answered by the dev-only Redis mock, DOMAINS_DNS_MOCK=redis:
 *     keys drobek:dns-mock:<txt|cname>:<name>, JSON string arrays);
 *   - Caddy's ask (GET /api/internal/tls/ask on the internal Host drobek:3000)
 *     → 200 only once verified, 404 before / after;
 *   - the custom Host serves the published version; a primary domain makes the
 *     default host 302 to it;
 *   - the re-check (dev: every 5 s, DOMAINS_RECHECK_INTERVAL_MS) drops a
 *     backdated domain whose TXT record vanished and e-mails the owner (Mailpit);
 *   - drobek-owned names → hostname_not_allowed, IP literals → invalid_hostname,
 *     the 4th domain of an app → limit_exceeded (DOMAINS_MAX_PER_APP=3);
 *   - audit rows domain.add / domain.verify / domain.primary / domain.unverify /
 *     domain.remove.
 * The image flow (E2E_TARGET_PRODUCTION=1) ignores the DNS mock, so only the
 * DNS-free checks (refused names, the limit) run there.
 */

test.describe.configure({ mode: 'serial' });

const HOST = 'firma.test';
/** The custom host on the dev stack's app port (a custom Host must carry APPS_DOMAIN's port). */
const APPS_PORT = /:(\d+)$/.exec(APPS_DOMAIN)?.[1] ?? null;
const HOST_WITH_PORT = APPS_PORT ? `${HOST}:${APPS_PORT}` : HOST;
const TLS_ASK_TOKEN = process.env.TLS_ASK_TOKEN ?? 'dev-only-tls-ask-token-0123456789abcdef';

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

/**
 * Caddy's ask, exactly as Caddy sends it: to drobek's internal address (Host
 * drobek:3000 — never the public dashboard host). The dev stack publishes that
 * port as the dashboard's host port, so connect there with an explicit Host.
 */
function tlsAsk(domain: string): Promise<number> {
  const web = new URL(BASE_URL_WEB);
  const port = Number(web.port || (web.protocol === 'https:' ? 443 : 80));
  const path = `/api/internal/tls/ask?token=${encodeURIComponent(TLS_ASK_TOKEN)}&domain=${encodeURIComponent(domain)}`;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { Host: 'drobek:3000' }, setHost: false },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      }
    );
    req.setTimeout(15_000, () => req.destroy(new Error(`timeout: tls ask ${domain}`)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * A GET on the custom host. `firma.test` resolves nowhere, so — like a browser
 * pointed at it by DNS — connect to the local stack's app port with the Host
 * header set (helpers/apps-host only short-circuits *.localhost).
 */
function customGet(path = '/'): Promise<Raw> {
  const port = Number(APPS_PORT ?? 80);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { Host: HOST_WITH_PORT }, setHost: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      }
    );
    req.setTimeout(15_000, () => req.destroy(new Error(`timeout: http://${HOST_WITH_PORT}${path}`)));
    req.on('error', reject);
    req.end();
  });
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

test.describe('custom domains (M3-01) @local', () => {
  test('add → instructions → verify → ask/serve/primary → re-check drops it + mails the owner → remove', async ({
    page,
    request,
  }) => {
    skipUnlessLocal();
    test.skip(TARGET_PRODUCTION, 'the Redis DNS mock is ignored when NODE_ENV=production');
    test.skip(APPS_URL_SCHEME !== 'http', 'the custom host is reached over plain http on the dev stack');
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
      await addDomain(page, 'Firma.TEST');
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
      expect(await tlsAsk('unknown-e2e.firma.test')).toBe(404);
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
      expect(moved.headers.location).toBe(`http://${HOST_WITH_PORT}/about?x=1`);

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
        .poll(async () => (await domainRow(HOST, app.id))?.verified_at ?? 'still verified', {
          timeout: 45_000,
          intervals: [1_000],
        })
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
});
