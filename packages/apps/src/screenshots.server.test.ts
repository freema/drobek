/**
 * Screenshots an agent asks for, on a real (PGlite) database and the
 * in-memory request store: a request is announced to the previews and
 * audited without its note, the per-app hourly limit refuses with its name,
 * the token works once and only until the request expires, a decline and a
 * capture each settle the request, a capture is stored re-encoded and kept by
 * the blob GC until the retention deletes it, and the answer endpoint lets
 * only the app's own hosts read its answers (CORS) and caps the body.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appScreenshots, auditLog, blobs, users, workspaces } from '@drobek/db';
import {
  AppsError,
  captureScreenshot,
  createApp,
  createScreenshotUploadHandler,
  declineScreenshot,
  getAppScreenshot,
  isScreenshotRequestId,
  listAppScreenshots,
  lookupScreenshot,
  memoryScreenshotRequestStore,
  pruneOldScreenshots,
  requestScreenshot,
  screenshotLimits,
  screenshotOriginAllowed,
  sweepUnreferencedBlobs,
  validateScreenshotNote,
  type Actor,
  type AppChangedEvent,
  type ScreenshotRequestStore,
} from './index.js';
import { freshDb, type TestDb } from './test/db.js';

let db: TestDb;
let close: () => Promise<void>;
let ann: Actor & { userId: string };

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const [a] = await db.insert(users).values({ email: 'ann@example.test' }).returning();
  ann = { userId: a.id, kind: 'agent' };
});
afterAll(async () => close());

let n = 0;
async function newApp(): Promise<{ id: string; slug: string; workspaceId: string }> {
  n += 1;
  const [ws] = await db.insert(workspaces).values({ kind: 'team', slug: `ss-${n}`, name: `Shots ${n}` }).returning();
  const app = await createApp({ workspaceId: ws.id, slug: `shot-app-${n}`, actor: { userId: ann.userId, kind: 'user' } });
  return { ...app, workspaceId: ws.id };
}

function clock(start = Date.UTC(2026, 9, 18, 12)) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const limits = { requestTtlSec: 600, requestsPerAppHour: 20, retentionDays: 7 };
const hosts = { appsDomain: 'drobek.app', dashboardHost: 'dash.drobek.app' };

function setup() {
  const c = clock();
  const store = memoryScreenshotRequestStore(c.now);
  const events: AppChangedEvent[] = [];
  const deps = { store, now: c.now, limits, notify: async (e: AppChangedEvent) => void events.push(e) };
  return { c, store, events, deps };
}

async function png(width = 2400, height = 1200): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#3366ff' } }).png().toBuffer();
}

describe('screenshot limits and note', () => {
  it('reads the three env limits with their defaults', () => {
    expect(screenshotLimits({})).toEqual({ requestTtlSec: 600, requestsPerAppHour: 20, retentionDays: 7 });
    expect(screenshotLimits({ SCREENSHOT_REQUEST_TTL_SEC: '30', SCREENSHOT_REQUESTS_PER_APP_HOUR: '2', SCREENSHOTS_RETENTION_DAYS: 'x' })).toEqual({
      requestTtlSec: 30,
      requestsPerAppHour: 2,
      retentionDays: 7,
    });
  });

  it('keeps a note on one line, at most 200 characters', () => {
    expect(validateScreenshotNote(undefined)).toEqual({ ok: true, note: null });
    expect(validateScreenshotNote('  the\nheader\u0007  ')).toEqual({ ok: true, note: 'the header' });
    expect(validateScreenshotNote('x'.repeat(200))).toEqual({ ok: true, note: 'x'.repeat(200) });
    expect(validateScreenshotNote('x'.repeat(201)).ok).toBe(false);
    expect(validateScreenshotNote(3).ok).toBe(false);
  });
});

describe('requestScreenshot', () => {
  it('stores a pending request, announces it to the previews and audits it without the note', async () => {
    const app = await newApp();
    const { deps, events, store } = setup();
    const req = await requestScreenshot({ app, version: 3, note: 'Is the menu cut off?', actor: ann }, deps);
    expect(isScreenshotRequestId(req.id)).toBe(true);
    expect(req.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(req.expiresAt - req.requestedAt).toBe(600_000);
    expect(events).toEqual([
      { app_id: app.id, slug: app.slug, kind: 'screenshot', screenshot: { state: 'requested', request_id: req.id, token: req.token, note: 'Is the menu cut off?', expires_at: req.expiresAt } },
    ]);
    expect((await store.pending(app.id, deps.now())).map((r) => r.id)).toEqual([req.id]);
    expect(await lookupScreenshot(req.id, deps)).toMatchObject({ state: 'pending', appId: app.id });
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.action, 'app.screenshot.request'), eq(auditLog.target, app.slug)));
    expect(audit).toMatchObject({ actorUserId: ann.userId, actorKind: 'agent', meta: { appId: app.id, request: req.id, version: 3 } });
  });

  it('refuses a long note and more than SCREENSHOT_REQUESTS_PER_APP_HOUR requests an hour', async () => {
    const app = await newApp();
    const { deps, c } = setup();
    await expect(requestScreenshot({ app, version: 1, note: 'x'.repeat(201), actor: ann }, deps)).rejects.toMatchObject({ code: 'invalid_settings' });
    const tight = { ...deps, limits: { ...limits, requestsPerAppHour: 2 } };
    await requestScreenshot({ app, version: 1, actor: ann }, tight);
    await requestScreenshot({ app, version: 1, actor: ann }, tight);
    const err = (await requestScreenshot({ app, version: 1, actor: ann }, tight).catch((e: unknown) => e)) as AppsError;
    expect(err).toBeInstanceOf(AppsError);
    expect(err.code).toBe('rate_limited');
    expect(err.details).toMatchObject({ limit: 'SCREENSHOT_REQUESTS_PER_APP_HOUR', value: 2 });
    expect(err.details?.retry_after_seconds).toBeGreaterThan(0);
    c.advance(60 * 60 * 1000);
    await expect(requestScreenshot({ app, version: 1, actor: ann }, tight)).resolves.toMatchObject({ state: 'pending' });
  });
});

describe('answering a request', () => {
  it('a capture is stored re-encoded, settles the request and the token works once', async () => {
    const app = await newApp();
    const { deps, events, store } = setup();
    const req = await requestScreenshot({ app, version: 4, note: 'the header', actor: ann }, deps);
    await expect(captureScreenshot({ id: req.id, token: 'x'.repeat(43), image: await png() }, deps)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(captureScreenshot({ id: req.id, token: req.token, image: Buffer.from('not an image') }, deps)).rejects.toMatchObject({ code: 'invalid_image' });
    const shot = await captureScreenshot({ id: req.id, token: req.token, image: await png(), path: '/pricing?x=1', browser: 'chrome' }, deps);
    expect(shot).toMatchObject({ id: req.id, appId: app.id, versionNumber: 4, path: '/pricing', note: 'the header', browser: 'chrome', width: 1600, height: 800, requestedByEmail: 'ann@example.test' });
    expect(events.at(-1)).toEqual({ app_id: app.id, slug: app.slug, kind: 'screenshot', screenshot: { state: 'done', request_id: req.id } });
    await expect(captureScreenshot({ id: req.id, token: req.token, image: await png() }, deps)).rejects.toMatchObject({ code: 'not_found' });
    await expect(declineScreenshot({ id: req.id, token: req.token }, deps)).rejects.toMatchObject({ code: 'not_found' });
    expect(await store.pending(app.id, deps.now())).toEqual([]);
    expect(await lookupScreenshot(req.id, deps)).toMatchObject({ state: 'ready', appId: app.id, screenshot: { width: 1600 } });
    const full = await getAppScreenshot(app.id, req.id);
    expect(full?.mimeType).toBe('image/webp');
    expect((await sharp(full!.data).metadata()).format).toBe('webp');
    expect(await getAppScreenshot('other', req.id)).toBeNull();
    expect((await listAppScreenshots(app.id)).map((s) => s.id)).toEqual([req.id]);
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.action, 'app.screenshot.capture'), eq(auditLog.target, app.slug)));
    expect(audit).toMatchObject({ actorUserId: null, meta: { appId: app.id, request: req.id, version: 4, browser: 'chrome' } });
  });

  it('a decline settles the request; an unanswered one expires', async () => {
    const app = await newApp();
    const { deps, c } = setup();
    const declined = await requestScreenshot({ app, version: 1, actor: ann }, deps);
    await declineScreenshot({ id: declined.id, token: declined.token }, deps);
    expect(await lookupScreenshot(declined.id, deps)).toMatchObject({ state: 'declined' });
    await expect(captureScreenshot({ id: declined.id, token: declined.token, image: await png(10, 10) }, deps)).rejects.toMatchObject({ code: 'not_found' });
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.action, 'app.screenshot.decline'), eq(auditLog.target, app.slug)));
    expect(audit?.meta).toEqual({ appId: app.id, request: declined.id, version: 1 });

    const late = await requestScreenshot({ app, version: 1, actor: ann }, deps);
    c.advance(600_001);
    expect(await lookupScreenshot(late.id, deps)).toMatchObject({ state: 'expired' });
    await expect(captureScreenshot({ id: late.id, token: late.token, image: await png(10, 10) }, deps)).rejects.toMatchObject({ code: 'not_found' });
    expect(await lookupScreenshot('ss_000000000000000000000000', deps)).toBeNull();
  });

  it('the claim is one-time even when two answers pass the token check together', async () => {
    const app = await newApp();
    const { deps } = setup();
    const req = await requestScreenshot({ app, version: 1, actor: ann }, deps);
    const image = await png(20, 20);
    const out = await Promise.allSettled([
      captureScreenshot({ id: req.id, token: req.token, image }, deps),
      declineScreenshot({ id: req.id, token: req.token }, deps),
    ]);
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  });

  it('the retention deletes old screenshots and the blob GC then frees their bytes', async () => {
    const app = await newApp();
    const { deps } = setup();
    const req = await requestScreenshot({ app, version: 1, actor: ann }, deps);
    await captureScreenshot({ id: req.id, token: req.token, image: await png(30, 30) }, deps);
    const [row] = await db.select().from(appScreenshots).where(eq(appScreenshots.id, req.id));
    await db.update(blobs).set({ createdAt: new Date(Date.now() - 30 * 86_400_000) }).where(eq(blobs.sha256, row.sha256));
    await sweepUnreferencedBlobs({ graceMs: 0 });
    expect(await db.select().from(blobs).where(eq(blobs.sha256, row.sha256))).toHaveLength(1);
    expect(await pruneOldScreenshots({ retentionDays: 7, now: new Date(row.capturedAt.getTime() + 6 * 86_400_000) })).toBe(0);
    expect(await pruneOldScreenshots({ retentionDays: 7, now: new Date(row.capturedAt.getTime() + 8 * 86_400_000) })).toBeGreaterThanOrEqual(1);
    await sweepUnreferencedBlobs({ graceMs: 0 });
    expect(await db.select().from(blobs).where(eq(blobs.sha256, row.sha256))).toHaveLength(0);
  });
});

describe('screenshotOriginAllowed', () => {
  const app = { id: 'a1', slug: 'shop' };
  const verified = async (appId: string, hostname: string) => appId === 'a1' && hostname === 'shop.example.com';
  it('admits only the app\'s own hosts', async () => {
    for (const o of ['https://shop--preview.drobek.app', 'https://shop.drobek.app', 'https://shop--v3.drobek.app', 'https://shop.example.com']) {
      expect(await screenshotOriginAllowed(o, app, { hosts, verifiedDomain: verified }), o).toBe(true);
    }
    for (const o of [
      'https://other--preview.drobek.app',
      'https://dash.drobek.app',
      'https://drobek.app',
      'https://x.shop--preview.drobek.app',
      'https://evil.example',
      'http://shop.example.com',
      'https://shop--preview.drobek.app:8443',
      'null',
      'https://shop--preview.drobek.app/path',
    ]) {
      expect(await screenshotOriginAllowed(o, app, { hosts, verifiedDomain: verified }), o).toBe(false);
    }
  });
});

describe('the answer endpoint', () => {
  let server: Server;
  let base: string;
  let store: ScreenshotRequestStore;
  let deps: ReturnType<typeof setup>['deps'];
  const imageLimits = { screenshotMaxBytes: 200 * 1024, mcpImageMaxBytes: 400 * 1024 };

  beforeAll(async () => {
    const s = setup();
    store = s.store;
    deps = s.deps;
    const handler = createScreenshotUploadHandler({
      hint: (code) => `hint for ${code}`,
      store,
      imageLimits,
      hosts,
      verifiedDomain: async () => false,
      notify: deps.notify,
      now: deps.now,
    });
    server = createServer((req, res) => handler(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/screenshots/`;
  });
  afterAll(async () => new Promise<void>((r) => server.close(() => r())));

  function form(fields: Record<string, string | Blob>): FormData {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.append(k, v);
    return f;
  }

  it('the app\'s preview reads its answer (CORS); another origin is refused before anything happens', async () => {
    const app = await newApp();
    const req = await requestScreenshot({ app, version: 2, actor: ann }, deps);
    const origin = `https://${app.slug}--preview.drobek.app`;
    const pre = await fetch(`${base}${req.id}`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(origin);
    expect(pre.headers.get('access-control-allow-credentials')).toBeNull();

    const foreign = await fetch(`${base}${req.id}`, { method: 'POST', headers: { Origin: 'https://other--preview.drobek.app' }, body: form({ token: req.token, action: 'decline' }) });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    expect(await lookupScreenshot(req.id, deps)).toMatchObject({ state: 'pending' });

    const image = new Blob([new Uint8Array(await png(640, 400))], { type: 'image/png' });
    const ok = await fetch(`${base}${req.id}`, { method: 'POST', headers: { Origin: origin }, body: form({ token: req.token, screenshot: image, path: '/', browser: 'safari' }) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(origin);
    expect(await ok.json()).toEqual({ status: 'ready', width: 640, height: 400 });
    const again = await fetch(`${base}${req.id}`, { method: 'POST', body: form({ token: req.token, screenshot: image }) });
    expect(again.status).toBe(404);
    expect(await again.json()).toMatchObject({ code: 'not_found', hint: 'hint for not_found' });
  });

  it('declines, refuses a wrong token, a body over the limit, a non-image and other methods', async () => {
    const app = await newApp();
    const req = await requestScreenshot({ app, version: 2, actor: ann }, deps);
    expect((await fetch(`${base}${req.id}`, { method: 'POST', body: form({ token: 'wrong', action: 'decline' }) })).status).toBe(403);
    const big = new Blob([new Uint8Array(imageLimits.screenshotMaxBytes + 70 * 1024)], { type: 'image/png' });
    expect((await fetch(`${base}${req.id}`, { method: 'POST', body: form({ token: req.token, screenshot: big }) })).status).toBe(413);
    const text = new Blob(['hello'], { type: 'image/png' });
    expect((await fetch(`${base}${req.id}`, { method: 'POST', body: form({ token: req.token, screenshot: text }) })).status).toBe(415);
    expect((await fetch(`${base}${req.id}`, { method: 'POST', body: 'token=x' })).status).toBe(400);
    expect((await fetch(`${base}${req.id}`)).status).toBe(405);
    expect((await fetch(`${base}nope`, { method: 'POST', body: form({ token: req.token }) })).status).toBe(404);
    const declined = await fetch(`${base}${req.id}`, { method: 'POST', body: form({ token: req.token, action: 'decline' }) });
    expect(await declined.json()).toEqual({ status: 'declined' });
    expect(await lookupScreenshot(req.id, deps)).toMatchObject({ state: 'declined' });
  });
});
