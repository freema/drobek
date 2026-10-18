/**
 * A screenshot on a feedback note, in the dashboard against a real PGlite
 * database (the session and the workspace role gate are stubbed):
 *
 *  - /feedback/new takes a multipart `screenshot` file: stored re-encoded,
 *    413 past SCREENSHOT_MAX_BYTES (a declared length or the file), 400 for a
 *    file that is not a PNG / JPEG / WebP; the page's own body limit;
 *  - the screenshot route: members only, a WebP with nosniff and a sandbox
 *    CSP, a thumbnail, 304 for an unchanged image, 404 for a note without
 *    one and once the note is deleted.
 */
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@drobek/db/schema';
import { appFeedback, apps, auditLog, setDbForTests, users, workspaces } from '@drobek/db';

type Role = 'viewer' | 'editor' | 'workspace-admin';
const s = vi.hoisted(() => ({
  user: null as null | { id: string; email: string },
  role: 'viewer' as Role,
  member: true,
  ws: { id: '', slug: 'acme', name: 'Acme', kind: 'team' as const },
}));

vi.mock('@drobek/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drobek/auth')>()),
  getSessionUser: async () => s.user,
}));
vi.mock('@drobek/tenancy', async (importOriginal) => {
  const rank = { viewer: 1, editor: 2, 'workspace-admin': 3 } as const;
  return {
    ...(await importOriginal<typeof import('@drobek/tenancy')>()),
    requireWorkspaceRole: async (_request: Request, slug: string, min: Role) => {
      if (!s.user) throw new Response(null, { status: 302, headers: { Location: '/login' } });
      if (slug !== s.ws.slug || !s.member) throw new Response('Not found', { status: 404 });
      if (rank[s.role] < rank[min]) throw new Response('Forbidden', { status: 403 });
      return { user: s.user, workspace: s.ws, membershipRole: s.role, superAdmin: false, effectiveRole: s.role };
    },
  };
});
vi.mock('../app-page.server.js', () => ({ appHeaderFor: async () => ({}) }));

const popup = await import('./feedback.new.server.js');
const tab = await import('./workspaces.$slug.apps.$appSlug.feedback.server.js');
const image = await import('./workspaces.$slug.apps.$appSlug.feedback.$id.screenshot.server.js');

let pg: PGlite;
const db = () => drizzle(pg, { schema });
let vera = { id: '', email: '' };

/** A noisy RGB PNG (hard to compress, so its size follows its pixels). */
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
  let seed = 3;
  for (let y = 0; y < height; y++) {
    for (let i = 1; i <= width * 3; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      raw[y * (width * 3 + 1) + i] = seed >> 16;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const status = (res: unknown) => (res instanceof Response ? res.status : ((res as { init: { status: number } | null }).init?.status ?? 200));
const body = <T,>(res: unknown) => (res && typeof res === 'object' && 'data' in res ? (res as { data: T }).data : (res as T));
const thrown = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

const NEW = 'https://drobek.example/feedback/new';
function sendNote(fields: Record<string, string>, file?: { bytes: Buffer; name: string; type: string }, headers: Record<string, string> = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  if (file) form.set('screenshot', new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
  const request = new Request(NEW, { method: 'POST', body: form, headers });
  return popup.action({ request, params: {}, context: {} } as never);
}

const TAB = 'https://drobek.example/workspaces/acme/apps/shop/feedback';
const params = { slug: 'acme', appSlug: 'shop' };
const loadTab = () => tab.loader({ request: new Request(TAB), params, context: {} } as never);
const getImage = (id: string, query = '', headers: Record<string, string> = {}) =>
  image.loader({ request: new Request(`${TAB}/${id}/screenshot${query}`, { headers }), params: { ...params, id }, context: {} } as never);

beforeAll(async () => {
  pg = new PGlite();
  await migrate(db(), {
    migrationsFolder: fileURLToPath(new URL('../../../db/drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_core',
    migrationsSchema: 'drizzle',
  });
  setDbForTests(db());
  const [u] = await db().insert(users).values({ email: 'vera@example.com' }).returning();
  vera = { id: u.id, email: u.email };
  const [w] = await db().insert(workspaces).values({ kind: 'team', slug: 'acme', name: 'Acme' }).returning();
  s.ws = { ...s.ws, id: w.id };
  await db().insert(apps).values({ workspaceId: w.id, slug: 'shop', name: 'Shop' });
  process.env.APPS_DOMAIN = 'apps.example';
  process.env.PUBLIC_APP_URL = 'https://drobek.example';
});

afterAll(async () => {
  await pg.close();
});

beforeEach(() => {
  s.user = vera;
  s.role = 'viewer';
  s.member = true;
  delete process.env.SCREENSHOT_MAX_BYTES;
});

let noteId = '';
let plainId = '';

describe('/feedback/new with a screenshot', () => {
  it('tells the page the limits it shrinks a screenshot to', async () => {
    const res = await popup.loader({ request: new Request(`${NEW}?app=shop`), params: {}, context: {} } as never);
    expect(body<{ screenshot: unknown }>(res).screenshot).toEqual({ maxBytes: 1024 * 1024, maxSide: 1600 });
  });

  it('stores the note with the re-encoded screenshot and audits that it has one', async () => {
    const res = await sendNote({ app: 'shop', path: '/cart', body: 'The header is cut off.' }, { bytes: png(1800, 900), name: 'shot.png', type: 'image/png' });
    const r = body<{ ok: boolean; id: string }>(res);
    expect(r.ok).toBe(true);
    noteId = r.id;
    const [row] = await db().select().from(appFeedback).where(eq(appFeedback.id, r.id));
    expect(row).toMatchObject({ screenshotWidth: 1600, screenshotHeight: 800 });
    expect(row.screenshotSha256).toMatch(/^[0-9a-f]{64}$/);
    const audits = await db().select().from(auditLog).where(eq(auditLog.action, 'app.feedback.create'));
    expect(audits.at(-1)?.meta).toMatchObject({ feedback: r.id, screenshot: true });
    const plain = body<{ ok: boolean; id: string }>(await sendNote({ app: 'shop', body: 'No picture.' }, { bytes: Buffer.alloc(0), name: '', type: 'application/octet-stream' }));
    expect(plain.ok).toBe(true);
    plainId = plain.id;
  });

  it('413 for a screenshot over SCREENSHOT_MAX_BYTES, the text kept; 413 for a declared body over the page limit', async () => {
    process.env.SCREENSHOT_MAX_BYTES = '4096';
    const res = await sendNote({ app: 'shop', body: 'Too big.' }, { bytes: png(200, 200), name: 'big.png', type: 'image/png' });
    expect(status(res)).toBe(413);
    expect(body<{ ok: boolean; body: string; error: string }>(res)).toMatchObject({ ok: false, body: 'Too big.' });
    expect(body<{ error: string }>(res).error).toContain('SCREENSHOT_MAX_BYTES');
    const declared = await popup.action({
      request: new Request(NEW, { method: 'POST', body: 'x', headers: { 'Content-Length': String(4096 + 64 * 1024 + 1), 'Content-Type': 'text/plain' } }),
      params: {},
      context: {},
    } as never);
    expect(status(declared)).toBe(413);
  });

  it('400 for a file that is not a PNG, JPEG or WebP, whatever its name and type say', async () => {
    const res = await sendNote({ app: 'shop', body: 'Fake.' }, { bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), name: 'x.png', type: 'image/png' });
    expect(status(res)).toBe(400);
    expect(body<{ ok: boolean; body: string }>(res)).toMatchObject({ ok: false, body: 'Fake.' });
  });

  it('a non-member cannot post a screenshot either', async () => {
    s.member = false;
    expect(status(await thrown(sendNote({ app: 'shop', body: 'x' }, { bytes: png(10, 10), name: 'a.png', type: 'image/png' })))).toBe(404);
  });
});

describe('the screenshot on the Feedback tab', () => {
  it('lists the screenshot with its route', async () => {
    const d = await loadTab();
    const row = d.rows.find((r) => r.id === noteId)!;
    expect(row.screenshot).toMatchObject({ url: `/workspaces/acme/apps/shop/feedback/${noteId}/screenshot`, width: 1600, height: 800 });
    expect(d.rows.find((r) => r.id === plainId)!.screenshot).toBeNull();
  });

  it('serves the WebP to members with nosniff and a sandbox CSP; a thumbnail; 304 when unchanged', async () => {
    const res = await getImage(noteId);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/webp');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache');
    const full = Buffer.from(await res.arrayBuffer());
    expect(full.subarray(8, 12).toString('latin1')).toBe('WEBP');
    const etag = res.headers.get('ETag')!;
    expect((await getImage(noteId, '', { 'If-None-Match': etag })).status).toBe(304);
    const thumb = await getImage(noteId, '?size=thumb');
    expect(thumb.status).toBe(200);
    const small = Buffer.from(await thumb.arrayBuffer());
    expect(small.length).toBeLessThan(full.length);
    expect(thumb.headers.get('ETag')).not.toBe(etag);
  });

  it('404 for a note without a screenshot, a wrong id and a non-member', async () => {
    expect((await getImage(plainId)).status).toBe(404);
    expect((await getImage('fb_000000000000000000000000')).status).toBe(404);
    expect((await getImage('nope')).status).toBe(404);
    s.member = false;
    expect(status(await thrown(getImage(noteId)))).toBe(404);
  });

  it('deleting the note makes the route answer 404', async () => {
    const del = await tab.action({
      request: new Request(TAB, { method: 'POST', body: new URLSearchParams({ intent: 'delete', id: noteId }) }),
      params,
      context: {},
    } as never);
    expect(status(del)).toBe(302);
    expect((await getImage(noteId)).status).toBe(404);
  });
});
