import { createHash, randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { Redis } from 'ioredis';
import { APPS_URL_SCHEME, TEST_ENV } from '../playwright.config';
import { previewHost, urlOf } from './helpers/apps-host';
import { skipUnlessLocal } from './helpers/auth';
import { seedApp, seedVersion, withDb } from './helpers/seed';

/**
 * The provider sign-in's flow cookie cannot be planted by
 * a SIBLING app host. Two apps of this server are siblings under APPS_DOMAIN
 * (`<a>--preview.apps.localhost`, `<b>--preview.apps.localhost`); a page on
 * one may set a cookie with `Domain=<APPS_DOMAIN>` that the browser then
 * sends to the other. The flow cookie is `__Host-drobek_eu_flow` (Secure,
 * Path=/, no Domain): the browser refuses a `__Host-` cookie that names a
 * Domain, so only the target host itself can set it.
 *
 * The stack runs no sign-in provider module, so the spec seeds the handoff a
 * finished IdP callback would have stored (`drobek:eu-handoff:<code>`, bound
 * to the target host and to SHA-256 of a flow token the attacker knows) and
 * drives the browser against the REAL `complete` route:
 *
 *  - the attacker's `__Host-` cookie with a Domain is refused by Chromium;
 *    the legacy `__Secure-drobek_eu_flow` and the plain `drobek_eu_flow`
 *    Domain cookies DO reach the target (the injection channel is real) and
 *    `complete` refuses them — "Start again", no session;
 *  - no flow cookie, or a host-only one with another token → refused;
 *  - a host-only `__Host-` cookie set by the target host itself passes the
 *    flow check (the answer is the next check's: the provider is not on).
 *
 * https only: plain-http dev (`drobek_eu_flow`, no prefix) cannot keep a
 * sibling out — browsers enforce cookie prefixes on secure origins only.
 */

const FLOW = '__Host-drobek_eu_flow';
const HANDOFF_TTL_SEC = 60;

function redisClient(): Redis {
  const url = process.env.REDIS_URL;
  if (!url || TEST_ENV !== 'local') throw new Error('this spec needs TEST_ENV=local and a local REDIS_URL');
  return new Redis(url, { maxRetriesPerRequest: 1 });
}

const token = (): string => randomBytes(32).toString('base64url');
const sha256 = (v: string): string => createHash('sha256').update(v).digest('base64url');

/** What the dashboard-host callback stores for `complete` (modules/auth/src/flow.ts). */
async function seedHandoff(appId: string, host: string, flowToken: string): Promise<string> {
  const code = token();
  const record = {
    v: 2,
    app_id: appId,
    host,
    user_id: `eu_${randomBytes(12).toString('hex')}`,
    provider: 'oidc',
    is_new: false,
    flow: sha256(flowToken),
    connection: token(),
    return_to: '/',
  };
  const redis = redisClient();
  try {
    await redis.set(`drobek:eu-handoff:${code}`, JSON.stringify(record), 'EX', HANDOFF_TTL_SEC);
  } finally {
    redis.disconnect();
  }
  return code;
}

async function seedWorkspace(): Promise<string> {
  const id = `ws_${randomBytes(12).toString('hex')}`;
  const slug = `e2e-flow-${randomBytes(4).toString('hex')}`;
  await withDb((c) => c.query(`INSERT INTO workspaces (id, kind, slug, name) VALUES ($1, 'team', $2, 'Flow cookie e2e')`, [id, slug]));
  return id;
}

/** The name=value pairs of a Cookie header. */
function pairs(header: string): [string, string][] {
  return header
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)] as [string, string]);
}

/** GET complete?code= in the browser; the cookies the browser really sent, and the answer. */
async function openComplete(page: Page, host: string, code: string) {
  const response = await page.goto(`${urlOf(host)}/__drobek/v1/auth/complete?code=${code}`);
  expect(response).not.toBeNull();
  const sent = pairs((await response!.request().allHeaders()).cookie ?? '');
  return {
    status: response!.status(),
    sent: (name: string) => sent.filter(([n]) => n === name).map(([, v]) => v),
    setCookie: (await response!.allHeaders())['set-cookie'] ?? null,
    text: await page.content(),
  };
}

test.describe('auth provider flow cookie — sibling app hosts @local', () => {
  test.skip(APPS_URL_SCHEME !== 'https', 'cookie prefixes need https app hosts (task e2e:image)');

  let targetId: string;
  let target: string;
  let evil: string;

  test.beforeAll(async () => {
    skipUnlessLocal();
    const ws = await seedWorkspace();
    const a = await seedApp({ workspaceId: ws });
    const b = await seedApp({ workspaceId: ws });
    await seedVersion({ appId: a.id });
    await seedVersion({ appId: b.id });
    targetId = a.id;
    target = previewHost(a.slug);
    evil = previewHost(b.slug);
  });

  test('a sibling cannot plant the accepted flow cookie; the legacy names it can plant are refused', async ({ page }) => {
    skipUnlessLocal();
    const planted = token();
    const code = await seedHandoff(targetId, target, planted);
    const domain = new URL(urlOf(evil)).hostname.split('.').slice(1).join('.');

    await page.goto(urlOf(evil));
    const stored = await page.evaluate(
      ({ value, domain }) => {
        const attrs = `Domain=${domain}; Path=/; Secure; SameSite=Lax`;
        document.cookie = `__Host-drobek_eu_flow=${value}; ${attrs}`;
        document.cookie = `__Secure-drobek_eu_flow=${value}; ${attrs}`;
        document.cookie = `drobek_eu_flow=${value}; ${attrs}`;
        return document.cookie;
      },
      { value: planted, domain }
    );
    expect(stored).not.toContain('__Host-drobek_eu_flow');
    expect(stored).toContain('__Secure-drobek_eu_flow');

    const r = await openComplete(page, target, code);
    // the Domain cookies really reach the sibling …
    expect(r.sent('__Secure-drobek_eu_flow')).toEqual([planted]);
    expect(r.sent('drobek_eu_flow')).toEqual([planted]);
    // … but never under the one name complete accepts
    expect(r.sent(FLOW)).toEqual([]);
    expect(r.status).toBe(400);
    expect(r.text).toContain('Start again');
    expect(r.setCookie).toBeNull();
  });

  test('complete without a flow cookie, or with the host-only cookie of another sign-in, is refused', async ({ browser }) => {
    skipUnlessLocal();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const missing = await openComplete(page, target, await seedHandoff(targetId, target, token()));
      expect(missing.sent(FLOW)).toEqual([]);
      expect(missing.status).toBe(400);
      expect(missing.text).toContain('Start again');

      const other = token();
      await page.evaluate((v) => {
        document.cookie = `__Host-drobek_eu_flow=${v}; Path=/; Secure; SameSite=Lax`;
      }, other);
      const foreign = await openComplete(page, target, await seedHandoff(targetId, target, token()));
      expect(foreign.sent(FLOW)).toEqual([other]);
      expect(foreign.status).toBe(400);
      expect(foreign.text).toContain('Start again');
      expect(foreign.setCookie).toBeNull();
    } finally {
      await context.close();
    }
  });

  test("the target host's own host-only flow cookie passes the flow check", async ({ browser }) => {
    skipUnlessLocal();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const own = token();
      await page.goto(urlOf(target));
      await page.evaluate((v) => {
        document.cookie = `__Host-drobek_eu_flow=${v}; Path=/; Secure; SameSite=Lax`;
      }, own);
      const r = await openComplete(page, target, await seedHandoff(targetId, target, own));
      expect(r.sent(FLOW)).toEqual([own]);
      // past the flow check: the seeded provider is not on for this app → the next check refuses
      expect(r.status).toBe(403);
      expect(r.text).toContain('Not allowed');
      expect(r.text).not.toContain('Start again');
    } finally {
      await context.close();
    }
  });
});
