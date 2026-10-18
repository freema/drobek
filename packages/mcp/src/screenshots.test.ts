/**
 * request_screenshot and get_screenshot over a real MCP client on a real
 * (PGlite) database: the request (editor+, a compiled version, drobek.json
 * `"screenshots"`, the note, the hourly limit, the preview event) and every
 * state get_screenshot answers — pending, declined, expired and ready with
 * the image inside the untrusted envelope.
 */
import { crc32, deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureScreenshot, declineScreenshot, memoryScreenshotRequestStore, type AppChangedEvent } from '@drobek/apps';
import { auditLog, memberships, users, workspaces } from '@drobek/db';
import { eq } from 'drizzle-orm';
import type { ToolPrincipal } from './context.js';
import { freshDb, type TestDb } from './test/db.js';
import { connect, testDeps } from './test/harness.js';

let db: TestDb;
let close: () => Promise<void>;
const P = {} as Record<'ada' | 'vera' | 'eve', ToolPrincipal>;
let appId = '';
let now = Date.UTC(2026, 9, 18, 10);
const store = memoryScreenshotRequestStore(() => now);
const events: AppChangedEvent[] = [];

function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let seed = 7;
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let i = 1; i <= width * 3; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      raw[row + i] = seed >> 16;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

type Conn = Awaited<ReturnType<typeof connect>>;
async function as<T>(who: keyof typeof P, fn: (c: Conn) => Promise<T>, env: NodeJS.ProcessEnv = { APPS_DOMAIN: 'drobek.app' }): Promise<T> {
  const c = await connect(P[who], {
    ...testDeps(),
    env,
    now: () => now,
    screenshots: store,
    notifyAppChanged: async (e) => void events.push(e),
  });
  try {
    return await fn(c);
  } finally {
    await c.close();
  }
}

const quiet = { store, now: () => now, notify: async () => {} };

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const ids: Record<string, string> = {};
  for (const k of ['ada', 'vera', 'eve'] as const) ids[k] = (await db.insert(users).values({ email: `${k}@example.test` }).returning())[0].id;
  const [team] = await db.insert(workspaces).values({ kind: 'team', slug: 'team-q', name: 'Team Q' }).returning();
  const [other] = await db.insert(workspaces).values({ kind: 'personal', slug: 'eve-q', name: 'Eve' }).returning();
  await db.insert(memberships).values([
    { userId: ids.ada, workspaceId: team.id, role: 'editor' },
    { userId: ids.vera, workspaceId: team.id, role: 'viewer' },
    { userId: ids.eve, workspaceId: other.id, role: 'workspace-admin' },
  ]);
  for (const k of Object.keys(ids) as (keyof typeof P)[]) P[k] = { userId: ids[k], email: `${k}@example.test`, superAdmin: false };
  const app = await as('ada', async (c) => (await c.call('create_app', { name: 'Shot Board', workspace: 'team-q', template: 'html' })).body);
  appId = String(app.app_id);
});
afterAll(async () => close());

describe('request_screenshot', () => {
  it('creates a pending request, tells the preview and audits it; the note goes to the preview only', async () => {
    events.length = 0;
    const r = await as('ada', (c) => c.call('request_screenshot', { app_id: appId, note: 'The menu on a narrow window' }));
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({
      app_id: appId,
      status: 'pending',
      version: 1,
      preview_url: 'https://shot-board--preview.drobek.app',
      retry_after_seconds: 10,
      hint: 'ask the person to open the preview and click Capture',
      expires_at: new Date(now + 600_000).toISOString(),
    });
    expect(String(r.body.request_id)).toMatch(/^ss_[0-9a-f]{24}$/);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      app_id: appId,
      slug: 'shot-board',
      kind: 'screenshot',
      screenshot: { state: 'requested', request_id: r.body.request_id, note: 'The menu on a narrow window' },
    });
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, 'app.screenshot.request'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: P.ada.userId, actorKind: 'agent', target: 'shot-board' });
    expect(JSON.stringify(audit[0].meta)).not.toContain('narrow');
  });

  it('refuses a viewer, a foreign workspace, a long note and a version without screenshots', async () => {
    const viewer = await as('vera', (c) => c.call('request_screenshot', { app_id: appId }));
    expect(JSON.parse(viewer.text)).toMatchObject({ code: 'forbidden' });
    const foreign = await as('eve', (c) => c.call('request_screenshot', { app_id: appId }));
    expect(JSON.parse(foreign.text)).toMatchObject({ code: 'not_found' });
    const long = await as('ada', (c) => c.call('request_screenshot', { app_id: appId, note: 'x'.repeat(201) }));
    expect(JSON.parse(long.text)).toMatchObject({ code: 'invalid_params' });
    await as('ada', async (c) => {
      const w = await c.call('write_files', { app_id: appId, files: [{ path: 'drobek.json', content: '{ "screenshots": false }' }], reasoning: 'no screenshots' });
      expect(w.isError, w.text).toBe(false);
      expect(w.body.compile, w.text).toMatchObject({ ok: true });
      const off = await c.call('request_screenshot', { app_id: appId });
      expect(JSON.parse(off.text)).toMatchObject({ code: 'conflict' });
      expect(String(JSON.parse(off.text).message)).toContain('"screenshots": false');
      const on = await c.call('write_files', { app_id: appId, files: [{ path: 'drobek.json', delete: true }], reasoning: 'screenshots back' });
      expect(on.isError, on.text).toBe(false);
    });
  });

  it('stops at SCREENSHOT_REQUESTS_PER_APP_HOUR with retry_after_seconds', async () => {
    const env = { APPS_DOMAIN: 'drobek.app', SCREENSHOT_REQUESTS_PER_APP_HOUR: '1' };
    const r = await as('ada', (c) => c.call('request_screenshot', { app_id: appId }), env);
    expect(JSON.parse(r.text)).toMatchObject({ code: 'rate_limited', limit: 'SCREENSHOT_REQUESTS_PER_APP_HOUR', value: 1 });
    now += 3_600_000;
  });
});

describe('get_screenshot', () => {
  it('answers pending, then expired after SCREENSHOT_REQUEST_TTL_SEC', async () => {
    const id = String((await as('ada', (c) => c.call('request_screenshot', { app_id: appId }))).body.request_id);
    const pending = await as('vera', (c) => c.call('get_screenshot', { request_id: id }));
    expect(pending.body).toMatchObject({ app_id: appId, request_id: id, status: 'pending', retry_after_seconds: 10 });
    now += 601_000;
    const expired = await as('vera', (c) => c.call('get_screenshot', { request_id: id }));
    expect(expired.body).toMatchObject({ status: 'expired' });
    await expect(captureScreenshot({ id, token: 'x', image: png(10, 10) }, quiet)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('answers declined after Not now', async () => {
    const id = String((await as('ada', (c) => c.call('request_screenshot', { app_id: appId }))).body.request_id);
    const req = await store.get(id);
    await declineScreenshot({ id, token: req!.token }, quiet);
    const r = await as('ada', (c) => c.call('get_screenshot', { request_id: id }));
    expect(r.body).toMatchObject({ status: 'declined' });
  });

  it('answers ready with a JPEG under MCP_IMAGE_MAX_BYTES inside the untrusted envelope', async () => {
    const id = String((await as('ada', (c) => c.call('request_screenshot', { app_id: appId }))).body.request_id);
    const req = await store.get(id);
    await captureScreenshot({ id, token: req!.token, image: png(2400, 1200), path: '/menu', browser: 'firefox' }, quiet);
    const res = await as('vera', (c) => c.client.callTool({ name: 'get_screenshot', arguments: { request_id: id } }));
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toBeUndefined();
    const content = res.content as { type: string; text?: string; data?: string; mimeType?: string }[];
    expect(content.map((b) => b.type)).toEqual(['text', 'image', 'text']);
    const open = content[0].text!;
    expect(open.startsWith('UNTRUSTED CONTENT:')).toBe(true);
    const m = /<untrusted-agent-screenshot app_id="([^"]+)" request_id="([^"]+)" status="ready" version="3" page="\/menu" browser="firefox" captured_at="[^"]+" stored_width="1600" stored_height="800" width="(\d+)" height="(\d+)" bytes="(\d+)" mime_type="image\/jpeg" nonce="([0-9a-f]{16})">/.exec(open);
    expect(m, open).not.toBeNull();
    expect([m![1], m![2]]).toEqual([appId, id]);
    expect(content[2].text!.startsWith(`</untrusted-agent-screenshot nonce="${m![6]}">`)).toBe(true);
    const bytes = Buffer.from(content[1].data!, 'base64');
    expect(content[1].mimeType).toBe('image/jpeg');
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(bytes.length).toBeLessThanOrEqual(400 * 1024);
    expect(Math.max(Number(m![3]), Number(m![4]))).toBeLessThanOrEqual(1280);
  });

  it('a bad id is invalid_params; an unknown id and another workspace answer not_found', async () => {
    const id = String((await as('ada', (c) => c.call('request_screenshot', { app_id: appId }))).body.request_id);
    const bad = await as('ada', (c) => c.call('get_screenshot', { request_id: 'nope' }));
    expect(JSON.parse(bad.text)).toMatchObject({ code: 'invalid_params' });
    const unknown = await as('ada', (c) => c.call('get_screenshot', { request_id: 'ss_000000000000000000000000' }));
    expect(JSON.parse(unknown.text)).toMatchObject({ code: 'not_found' });
    const foreign = await as('eve', (c) => c.call('get_screenshot', { request_id: id }));
    expect(JSON.parse(foreign.text)).toMatchObject({ code: 'not_found' });
    expect(foreign.text).toBe(unknown.text.replace('ss_000000000000000000000000', id));
  });
});
