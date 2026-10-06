import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { APPS_URL_SCHEME, BASE_URL_WEB } from '../playwright.config';
import { hostRequest, previewHost, urlOf, type Raw } from './helpers/apps-host';
import { pollLoginCode, skipUnlessLocal } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';

/**
 * Live data subscriptions end to end (`drobek.data.subscribe`, the data
 * module's `GET /__drobek/v1/data/<collection>/events`):
 *
 *  - two browser pages of one app subscribe to a public collection; a
 *    create through the SDK on one page reaches the other page live;
 *  - a create_records over MCP (the owner's write, not the app's) reaches
 *    both pages;
 *  - under an owner-only read rule a signed-in user's page gets their own
 *    record but never another user's (written first, by REST);
 *  - a visitor's events carry no `_owner`.
 *
 * The dev quota is 5 records per app (DATA_MAX_DOCS_PER_APP): this spec
 * stores 4.
 */

interface Created {
  app_id: string;
  slug: string;
  workspace: string;
}

interface Live {
  syncs: number;
  changes: { op: string; id?: string; record?: Record<string, unknown> }[];
  errors: string[];
}

const SECURE = APPS_URL_SCHEME === 'https';
const COOKIE = SECURE ? '__Host-drobek_eu' : 'drobek_eu';
const STAMP = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const ANA = `e2e-live-ana-${STAMP}@example.com`;
const BOB = `e2e-live-bob-${STAMP}@example.com`;

function sdkHeaders(host: string, cookie?: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Origin: urlOf(host), 'X-Drobek-SDK': '1', ...(cookie ? { Cookie: cookie } : {}) };
}

/** send-code → the Mailpit code → verify on `host`: the cookie's value. */
async function signIn(request: APIRequestContext, host: string, email: string): Promise<string> {
  const sent = await hostRequest(host, '/__drobek/v1/auth/send-code', { method: 'POST', headers: sdkHeaders(host), body: JSON.stringify({ email }) });
  expect(sent.status, sent.body).toBe(200);
  const code = await pollLoginCode(request, email);
  const verified = await hostRequest(host, '/__drobek/v1/auth/verify', { method: 'POST', headers: sdkHeaders(host), body: JSON.stringify({ email, code }) });
  expect(verified.status, verified.body).toBe(200);
  const sc = verified.headers['set-cookie'];
  const m = new RegExp(`${COOKIE}=([0-9a-f]{64})`).exec((Array.isArray(sc) ? sc : sc ? [sc] : []).join('\n'));
  expect(m).toBeTruthy();
  return m![1];
}

function post(host: string, path: string, body: unknown, cookie?: string): Promise<Raw> {
  return hostRequest(host, `/__drobek/v1/data${path}`, { method: 'POST', headers: sdkHeaders(host, cookie), body: JSON.stringify(body) });
}

/** A page of the app (signed in when `cookie` is given) subscribed to `collection`; its events land in window.__live. */
async function subscribedPage(browser: Browser, host: string, collection: string, cookie?: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  if (cookie) await ctx.addCookies([{ name: COOKIE, value: cookie, url: urlOf(host) }]);
  const page = await ctx.newPage();
  await page.goto(urlOf(host));
  await page.evaluate(async (name) => {
    const { drobek } = await import('/__drobek/sdk.js' as string);
    const w = window as unknown as { __live: Live };
    w.__live = { syncs: 0, changes: [], errors: [] };
    drobek.data.subscribe(name, {
      onSync: () => {
        w.__live.syncs += 1;
      },
      onChange: (e: Live['changes'][number]) => w.__live.changes.push(e),
      onError: (e: { code: string }) => w.__live.errors.push(e.code),
    });
  }, collection);
  await expect.poll(() => live(page).then((l) => l.syncs), { message: 'the subscription is live' }).toBeGreaterThanOrEqual(1);
  return { ctx, page };
}

function live(page: Page): Promise<Live> {
  return page.evaluate(() => (window as unknown as { __live: Live }).__live);
}

const texts = (l: Live) => l.changes.map((c) => c.record?.text).filter(Boolean);

test.describe.configure({ mode: 'serial' });

test.describe('live data subscriptions @local', () => {
  let mcp: McpClient;
  let owner: BrowserContext;
  let app: Created;
  let host: string;
  const contexts: BrowserContext[] = [];

  test.afterAll(async () => {
    for (const c of contexts) await c.close();
    await mcp?.client.close();
    await owner?.close();
  });

  test('setup: an app with a public board (confirmed by the owner) and owner-only notes', async ({ page, request }) => {
    skipUnlessLocal();
    mcp = await mcpClient(page, request, { tag: 'data-realtime', scope: FULL_SCOPE });
    owner = await page.context().browser()!.newContext({ storageState: await page.context().storageState() });
    app = (await callTool(mcp.client, 'create_app', { name: 'Live board', template: 'react-ts' })).json as unknown as Created;
    host = previewHost(app.slug);

    const cfg = await callTool(mcp.client, 'configure_module', {
      app_id: app.app_id,
      module: 'data',
      config: { collections: { board: { rules: { read: 'public', create: 'public', update: 'admin', delete: 'admin' } }, notes: {} } },
    });
    expect(cfg.isError, JSON.stringify(cfg.json)).toBe(false);
    expect(cfg.json.applied).toBe(false);
    const confirmed = await owner.request.post(`${BASE_URL_WEB}/api/apps/${app.app_id}/modules/data/confirm`, { headers: { Origin: BASE_URL_WEB }, maxRedirects: 0 });
    expect(confirmed.status(), await confirmed.text()).toBe(200);
    const auth = await callTool(mcp.client, 'configure_module', { app_id: app.app_id, module: 'auth', config: { allow: { emails: [ANA, BOB] } } });
    expect(auth.isError, JSON.stringify(auth.json)).toBe(false);

    const refused = await hostRequest(host, '/__drobek/v1/data/notes/events');
    expect(refused.status, refused.body).toBe(401);
  });

  test('a create through the SDK on one page appears on the other page; an MCP create_records on both', async ({ browser }) => {
    skipUnlessLocal();
    const a = await subscribedPage(browser, host, 'board');
    const b = await subscribedPage(browser, host, 'board');
    contexts.push(a.ctx, b.ctx);

    const created = await a.page.evaluate(async () => {
      const { drobek } = await import('/__drobek/sdk.js' as string);
      return (await drobek.data.collection('board').create({ text: 'hello from A' })) as { _id: string };
    });
    await expect.poll(() => live(b.page).then(texts), { message: "page B sees page A's record" }).toContain('hello from A');
    const seen = (await live(b.page)).changes.find((c) => c.record?.text === 'hello from A')!;
    expect(seen).toMatchObject({ op: 'create', record: { _id: created._id } });
    expect(seen.record).not.toHaveProperty('_owner');

    const added = await callTool(mcp.client, 'create_records', { app_id: app.app_id, collection: 'board', records: [{ text: 'hello from the agent' }] });
    expect(added.isError, added.text).toBe(false);
    for (const p of [a.page, b.page]) {
      await expect.poll(() => live(p).then(texts), { message: 'the MCP record arrives live' }).toContain('hello from the agent');
    }
    expect((await live(a.page)).errors).toEqual([]);
  });

  test("an owner-only collection never streams another user's record", async ({ browser, request }) => {
    skipUnlessLocal();
    const ana = await signIn(request, host, ANA);
    const bob = await signIn(request, host, BOB);
    const b = await subscribedPage(browser, host, 'notes', bob);
    contexts.push(b.ctx);

    const anas = await post(host, '/notes', { text: 'ana private note' }, `${COOKIE}=${ana}`);
    expect(anas.status, anas.body).toBe(201);
    const bobs = await post(host, '/notes', { text: 'bob own note' }, `${COOKIE}=${bob}`);
    expect(bobs.status, bobs.body).toBe(201);

    await expect.poll(() => live(b.page).then(texts), { message: "bob's own note arrives" }).toContain('bob own note');
    // Ana's note was committed first: had it been sent, it would be here already.
    const l = await live(b.page);
    expect(texts(l)).toEqual(['bob own note']);
    expect(JSON.stringify(l)).not.toContain('ana private note');
    expect(l.errors).toEqual([]);
  });
});
