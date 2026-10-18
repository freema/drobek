import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { Redis } from 'ioredis';
import { BASE_URL_WEB, TEST_ENV } from '../playwright.config';
import { DASHBOARD_ORIGIN, hostRequest, previewHost, prodHost, urlOf, versionHost } from './helpers/apps-host';
import { skipUnlessLocal } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';

/**
 * A screenshot for the agent end to end on the local stack (the browser's
 * screen capture needs a person, so the test answers like the preview script
 * does: it reads the request from the preview's event stream and posts the
 * fixture with the one-time token):
 *
 *  - the preview tag carries `data-screenshots` and its CSP lets the page
 *    reach the dashboard origin; request_screenshot shows the bar on an open
 *    preview tab, whose event stream carries the request with its token;
 *  - the upload from the preview's origin is stored → get_screenshot answers
 *    `ready` with a JPEG image block in the untrusted envelope, the bar
 *    closes, the token works once, another origin is refused;
 *  - Not now (`action=decline`) → `declined`; a request past its expiry →
 *    `expired`;
 *  - the version host and production never carry the screenshot part;
 *  - the Feedback tab lists the screenshot.
 */

interface Created {
  app_id: string;
  slug: string;
}

interface Requested {
  type: 'screenshot_requested';
  request_id: string;
  token: string;
  note: string;
  expires_at: number;
}

const EVENTS_PATH = '/__drobek/preview/events';
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'feedback-screenshot.png');
const LOCAL_REDIS_HOSTS = ['localhost', '127.0.0.1', 'redis'];
const html = (title: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1></body></html>`;

/** Open the preview and record every message of a second event stream in `window.__shots`. */
async function openPreview(p: Page, slug: string): Promise<void> {
  const opened = p.waitForResponse((r) => new URL(r.url()).pathname === EVENTS_PATH && r.status() === 200, { timeout: 15_000 });
  await p.goto(`${urlOf(previewHost(slug))}/`);
  await opened;
  await p.evaluate((path) => {
    const w = window as unknown as { __shots: unknown[] };
    w.__shots = [];
    new EventSource(path).onmessage = (e) => w.__shots.push(JSON.parse(e.data as string));
  }, EVENTS_PATH);
}

/** The request event for `id` as the preview's event stream carried it. */
async function requestEvent(p: Page, id: string): Promise<Requested> {
  let found: Requested | undefined;
  await expect
    .poll(
      async () => {
        const seen = await p.evaluate(() => (window as unknown as { __shots: Requested[] }).__shots);
        found = seen.find((m) => m.type === 'screenshot_requested' && m.request_id === id);
        return Boolean(found);
      },
      { timeout: 10_000 }
    )
    .toBe(true);
  return found!;
}

function answer(request: APIRequestContext, id: string, origin: string, fields: Record<string, string>, file?: Buffer) {
  return request.post(`${BASE_URL_WEB}/api/screenshots/${id}`, {
    headers: { Origin: origin },
    multipart: { ...fields, ...(file ? { screenshot: { name: 'shot.png', mimeType: 'image/png', buffer: file } } : {}) },
  });
}

/** Move a stored request's expiry into the past (instead of waiting SCREENSHOT_REQUEST_TTL_SEC). */
async function expireRequest(id: string): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url || TEST_ENV !== 'local' || !LOCAL_REDIS_HOSTS.includes(new URL(url).hostname)) {
    throw new Error('expireRequest needs TEST_ENV=local and a local REDIS_URL (task e2e sets both)');
  }
  const redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: true });
  await redis.connect();
  try {
    const key = `drobek:screenshot:${id}`;
    const stored = JSON.parse((await redis.get(key))!) as { expiresAt: number };
    await redis.set(key, JSON.stringify({ ...stored, expiresAt: Date.now() - 1000 }), 'KEEPTTL');
    await redis.del(`drobek:screenshot:claim:${id}`);
  } finally {
    redis.disconnect();
  }
}

test.describe.configure({ mode: 'serial' });

test.describe('a screenshot for the agent @local', () => {
  let mcp: McpClient;
  let app: Created;
  let version = 0;
  let readyId = '';
  const preview = () => urlOf(previewHost(app.slug));

  test.afterAll(async () => {
    await mcp?.client.close();
  });

  test('the preview carries the screenshot part and may reach the dashboard origin', async ({ page: p, request }) => {
    skipUnlessLocal();
    mcp = await mcpClient(p, request, { tag: 'agent-shot', scope: FULL_SCOPE });
    app = (await callTool(mcp.client, 'create_app', { name: 'Shot request', template: 'html' })).json as unknown as Created;
    const w = await callTool(mcp.client, 'write_files', { app_id: app.app_id, files: [{ path: 'index.html', content: html('Menu') }], reasoning: 'A page' });
    expect(w.isError, JSON.stringify(w.json)).toBe(false);
    version = w.json.version as number;
    const page = await hostRequest(previewHost(app.slug), '/');
    expect(page.body).toContain(`data-version="${version}" data-reload data-errors data-screenshots></script>`);
    expect(String(page.headers['content-security-policy'])).toMatch(new RegExp(`connect-src [^;]*${DASHBOARD_ORIGIN.replace(/[.:/]/g, '\\$&')}\\/api\\/screenshots\\/`));
  });

  test('request → the bar and the event with its token → the upload → get_screenshot ready with the image', async ({ page: p, request }) => {
    skipUnlessLocal();
    await openPreview(p, app.slug);
    const asked = await callTool(mcp.client, 'request_screenshot', { app_id: app.app_id, note: 'The <b>menu</b> on a narrow window' });
    expect(asked.isError, JSON.stringify(asked.json)).toBe(false);
    expect(asked.json).toMatchObject({ status: 'pending', version, retry_after_seconds: 10, hint: 'ask the person to open the preview and click Capture' });
    readyId = asked.json.request_id as string;
    expect(readyId).toMatch(/^ss_[0-9a-f]{24}$/);

    const event = await requestEvent(p, readyId);
    expect(event.note).toBe('The <b>menu</b> on a narrow window');
    expect(event.token.length).toBeGreaterThanOrEqual(43);
    await expect(p.locator('[data-drobek-preview][data-ask]')).toBeAttached({ timeout: 10_000 });

    const pending = await callTool(mcp.client, 'get_screenshot', { request_id: readyId });
    expect(pending.json).toMatchObject({ status: 'pending', retry_after_seconds: 10 });

    const foreign = await answer(request, readyId, 'https://evil.example', { token: event.token }, readFileSync(FIXTURE));
    expect(foreign.status()).toBe(403);
    expect(foreign.headers()['access-control-allow-origin']).toBeUndefined();

    const sent = await answer(request, readyId, preview(), { token: event.token, path: '/', browser: 'chrome' }, readFileSync(FIXTURE));
    expect(sent.status(), await sent.text()).toBe(200);
    expect(sent.headers()['access-control-allow-origin']).toBe(preview());
    expect(await sent.json()).toMatchObject({ status: 'ready', width: 1440, height: 900 });
    await expect(p.locator('[data-drobek-preview][data-ask]')).toHaveCount(0, { timeout: 10_000 });

    const again = await answer(request, readyId, preview(), { token: event.token }, readFileSync(FIXTURE));
    expect(again.status()).toBe(404);

    const res = await mcp.client.callTool({ name: 'get_screenshot', arguments: { request_id: readyId } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toBeUndefined();
    const content = res.content as { type: string; text?: string; data?: string; mimeType?: string }[];
    expect(content.map((b) => b.type)).toEqual(['text', 'image', 'text']);
    expect(content[0].text).toContain('UNTRUSTED CONTENT:');
    expect(content[0].text).toMatch(new RegExp(`<untrusted-agent-screenshot app_id="${app.app_id}" request_id="${readyId}" status="ready" version="${version}" page="/" browser="chrome" captured_at="[^"]+" stored_width="1440" stored_height="900" width="1280" height="800" bytes="\\d+" mime_type="image/jpeg" nonce="[0-9a-f]{16}">`));
    expect(content[1].mimeType).toBe('image/jpeg');
    expect(Buffer.from(content[1].data!, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  test('Not now declines; a request past its expiry is expired and takes no upload', async ({ page: p, request }) => {
    skipUnlessLocal();
    await openPreview(p, app.slug);
    const declined = (await callTool(mcp.client, 'request_screenshot', { app_id: app.app_id })).json.request_id as string;
    const event = await requestEvent(p, declined);
    const no = await answer(request, declined, preview(), { token: event.token, action: 'decline' });
    expect(no.status()).toBe(200);
    expect(await no.json()).toEqual({ status: 'declined' });
    expect((await callTool(mcp.client, 'get_screenshot', { request_id: declined })).json).toMatchObject({ status: 'declined' });

    const late = (await callTool(mcp.client, 'request_screenshot', { app_id: app.app_id })).json.request_id as string;
    const lateEvent = await requestEvent(p, late);
    await expireRequest(late);
    expect((await callTool(mcp.client, 'get_screenshot', { request_id: late })).json).toMatchObject({ status: 'expired' });
    expect((await answer(request, late, preview(), { token: lateEvent.token }, readFileSync(FIXTURE))).status()).toBe(404);
  });

  test('the Feedback tab lists the screenshot for the agent', async ({ page: p }) => {
    skipUnlessLocal();
    await p.goto(`${BASE_URL_WEB}/workspaces/${mcp.workspace}/apps/${app.slug}/feedback`);
    const shot = p.locator(`[data-testid="agent-screenshot"][data-screenshot-id="${readyId}"]`);
    await expect(shot).toBeVisible();
    await expect(shot.getByTestId('agent-screenshot-note')).toHaveText('The <b>menu</b> on a narrow window');
    const full = await p.request.get(`${BASE_URL_WEB}/workspaces/${mcp.workspace}/apps/${app.slug}/feedback/screenshots/${readyId}`);
    expect(full.status()).toBe(200);
    expect(full.headers()['content-type']).toBe('image/webp');
  });

  test('a version host and production never carry the screenshot part', async () => {
    skipUnlessLocal();
    const pinned = await hostRequest(versionHost(app.slug, version), '/');
    expect(pinned.status).toBe(200);
    expect(pinned.body).not.toContain('data-screenshots');
    const pub = await callTool(mcp.client, 'publish', { app_id: app.app_id, version });
    expect(pub.isError, JSON.stringify(pub.json)).toBe(false);
    const prod = await hostRequest(prodHost(app.slug), '/');
    expect(prod.status).toBe(200);
    expect(prod.body).not.toContain('/__drobek/preview.js');
    const connect = String(prod.headers['content-security-policy']).split(';').find((d) => d.trim().startsWith('connect-src')) ?? '';
    expect(connect.split(/\s+/)).not.toContain(DASHBOARD_ORIGIN);
    expect((await hostRequest(prodHost(app.slug), EVENTS_PATH)).status).toBe(404);
  });

  test('"screenshots": false drops the bar and request_screenshot answers conflict', async () => {
    skipUnlessLocal();
    const off = await callTool(mcp.client, 'write_files', {
      app_id: app.app_id,
      files: [{ path: 'drobek.json', content: JSON.stringify({ screenshots: false }) }],
      reasoning: 'Screenshots off',
    });
    expect(off.isError, JSON.stringify(off.json)).toBe(false);
    expect((await hostRequest(previewHost(app.slug), '/')).body).not.toContain('data-screenshots');
    const refused = await callTool(mcp.client, 'request_screenshot', { app_id: app.app_id });
    expect(refused.isError).toBe(true);
    expect(refused.json).toMatchObject({ code: 'conflict' });
  });
});
