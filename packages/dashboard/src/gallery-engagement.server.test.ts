/**
 * The gallery's counting link and like page on a real PGlite
 * database (the session and the Redis limiter are stubbed):
 *  - GET /gallery/open/:slug: 302 to the production URL and one open counted;
 *    a prefetch, a HEAD and an IP over GALLERY_OPENS_PER_IP_HOUR redirect
 *    without counting; an app the gallery does not show → 404;
 *  - /gallery/like/:slug: signed out → /login?returnTo=; the page shows the
 *    count and the account's state; the POST likes / unlikes (one per
 *    account), returns to a GALLERY_FRAME_ANCESTORS `back` only, and past
 *    GALLERY_LIKES_PER_USER_HOUR answers 429;
 *  - the public list carries likes / opens / openUrl / likeUrl and sort=popular.
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@drobek/db/schema';
import { appVersions, apps, galleryLikes, galleryOpens, setDbForTests, users, workspaces } from '@drobek/db';

const session = vi.hoisted(() => ({ user: null as { id: string; email: string } | null }));
const rateLimitRedis = vi.hoisted(() =>
  vi.fn(async (_bucket: string, _key: string, _limit: number, _windowMs: number) => ({ ok: true }))
);
vi.mock('@drobek/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@drobek/auth')>();
  return {
    ...actual,
    getSessionUser: async () => session.user,
    rateLimitRedis: (...a: Parameters<typeof rateLimitRedis>) => rateLimitRedis(...a),
  };
});

const { loader: openLoader, GALLERY_OPENS_RATE_BUCKET } = await import('./routes/gallery.open.$slug.server.js');
const { loader: likeLoader, action: likeAction, safeGalleryBack, GALLERY_LIKES_RATE_BUCKET } = await import(
  './routes/gallery.like.$slug.server.js'
);
const { loader: galleryLoader } = await import('./routes/api.public.gallery.server.js');

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let appId: string;
let fanId: string;

function open(slug: string, init: RequestInit = {}) {
  const request = new Request(`https://drobek.example/gallery/open/${slug}`, init);
  return openLoader({ request, params: { slug }, context: {} } as never);
}

function likePage(slug: string, query = '') {
  const request = new Request(`https://drobek.example/gallery/like/${slug}${query}`);
  return likeLoader({ request, params: { slug }, context: {} } as never);
}

function like(slug: string, body: Record<string, string>) {
  const request = new Request(`https://drobek.example/gallery/like/${slug}`, { method: 'POST', body: new URLSearchParams(body) });
  return likeAction({ request, params: { slug }, context: {} } as never);
}

function payload<T>(res: unknown): { data: T; status?: number } {
  const d = res as { data: T; init?: { status?: number } };
  return { data: d.data, status: d.init?.status };
}

async function opensToday(): Promise<number> {
  const rows = await db.select().from(galleryOpens).where(eq(galleryOpens.appId, appId));
  return rows.reduce((s, r) => s + r.count, 0);
}

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg, { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../db/drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_core',
    migrationsSchema: 'drizzle',
  });
  setDbForTests(db);
  const [u] = await db.insert(users).values({ email: 'owner@example.com' }).returning();
  const [f] = await db.insert(users).values({ email: 'fan@example.com' }).returning();
  fanId = f.id;
  const [w] = await db.insert(workspaces).values({ kind: 'team', slug: 'acme', name: 'Acme' }).returning();
  const [a] = await db
    .insert(apps)
    .values({ workspaceId: w.id, slug: 'shift-plan', name: 'Shift planner', galleryListed: true, galleryDescription: 'Plans shifts.' })
    .returning();
  appId = a.id;
  const [v] = await db
    .insert(appVersions)
    .values({ appId, number: 1, compileStatus: 'ok', createdByUserId: u.id, actorKind: 'user' })
    .returning();
  await db.update(apps).set({ publishedVersionId: v.id, publishedAt: new Date('2026-09-20T10:00:00.000Z') }).where(eq(apps.id, appId));
  await db.insert(apps).values({ workspaceId: w.id, slug: 'draft-app', name: 'Draft' });
});

afterAll(async () => {
  await pg.close();
});

beforeEach(() => {
  vi.stubEnv('GALLERY_ENABLED', 'true');
  vi.stubEnv('APPS_DOMAIN', 'apps.example.test');
  vi.stubEnv('APPS_URL_SCHEME', 'https');
  vi.stubEnv('PUBLIC_APP_URL', 'https://drobek.example');
  vi.stubEnv('GALLERY_FRAME_ANCESTORS', 'https://www.example.test');
  session.user = null;
  rateLimitRedis.mockReset();
  rateLimitRedis.mockImplementation(async () => ({ ok: true }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /gallery/open/:slug', () => {
  it('302 to the production URL and one open counted; a prefetch, a HEAD and an IP over the limit are not counted', async () => {
    const before = await opensToday();
    const res = await open('shift-plan', { headers: { 'X-Real-IP': '203.0.113.9' } });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://shift-plan.apps.example.test');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await opensToday()).toBe(before + 1);

    expect((await open('shift-plan', { headers: { 'Sec-Purpose': 'prefetch' } })).status).toBe(302);
    expect((await open('shift-plan', { method: 'HEAD' })).status).toBe(302);
    rateLimitRedis.mockImplementation(async () => ({ ok: false }));
    expect((await open('shift-plan', { headers: { 'X-Real-IP': '203.0.113.9' } })).status).toBe(302);
    expect(await opensToday()).toBe(before + 1);
  });

  it('uses the per-IP bucket with GALLERY_OPENS_PER_IP_HOUR', async () => {
    vi.stubEnv('GALLERY_OPENS_PER_IP_HOUR', '7');
    await open('shift-plan', { headers: { 'x-real-ip': '203.0.113.9' } });
    expect(rateLimitRedis).toHaveBeenCalledWith(GALLERY_OPENS_RATE_BUCKET, '203.0.113.9', 7, 3_600_000);
  });

  it('an app the gallery does not show, an unknown slug, or no gallery → 404', async () => {
    expect((await open('draft-app')).status).toBe(404);
    expect((await open('nope')).status).toBe(404);
    vi.stubEnv('GALLERY_ENABLED', '');
    expect((await open('shift-plan')).status).toBe(404);
  });
});

describe('/gallery/like/:slug', () => {
  it('signed out → /login?returnTo= this page', async () => {
    const err = await likePage('shift-plan', '?back=https%3A%2F%2Fwww.example.test%2Fgallery').catch((e) => e);
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(302);
    expect((err as Response).headers.get('Location')).toBe(
      `/login?returnTo=${encodeURIComponent('/gallery/like/shift-plan?back=https%3A%2F%2Fwww.example.test%2Fgallery')}`
    );
  });

  it('likes once per account, unlikes, returns to an allowed back only', async () => {
    session.user = { id: fanId, email: 'fan@example.com' };
    const page = payload<{ name: string; likes: number; liked: boolean; back: string | null }>(
      await likePage('shift-plan', '?back=https%3A%2F%2Fwww.example.test%2Fgallery')
    );
    expect(page.data).toMatchObject({ name: 'Shift planner', likes: 0, liked: false, back: 'https://www.example.test/gallery' });

    expect(payload(await like('shift-plan', { intent: 'like' })).data).toEqual({ ok: true, likes: 1, liked: true });
    expect(payload(await like('shift-plan', { intent: 'like' })).data).toEqual({ ok: true, likes: 1, liked: true });
    expect(await db.select().from(galleryLikes)).toHaveLength(1);

    const back = await like('shift-plan', { intent: 'unlike', back: 'https://www.example.test/gallery' }).catch((e) => e);
    expect(back).toBeInstanceOf(Response);
    expect((back as Response).headers.get('Location')).toBe('https://www.example.test/gallery');
    expect(await db.select().from(galleryLikes)).toHaveLength(0);

    const elsewhere = await like('shift-plan', { intent: 'like', back: 'https://evil.example/' });
    expect(payload(elsewhere).data).toEqual({ ok: true, likes: 1, liked: true });
  });

  it('a bad intent → 400; past the per-account limit → 429 and nothing changes', async () => {
    session.user = { id: fanId, email: 'fan@example.com' };
    expect(payload(await like('shift-plan', { intent: 'love' })).status).toBe(400);
    rateLimitRedis.mockImplementation(async () => ({ ok: false }));
    const before = (await db.select().from(galleryLikes)).length;
    const limited = payload<{ ok: boolean }>(await like('shift-plan', { intent: 'unlike' }));
    expect(limited.status).toBe(429);
    expect(rateLimitRedis.mock.calls.at(-1)?.slice(0, 3)).toEqual([GALLERY_LIKES_RATE_BUCKET, fanId, 30]);
    expect((await db.select().from(galleryLikes)).length).toBe(before);
  });

  it('an app the gallery does not show → 404, even signed in', async () => {
    session.user = { id: fanId, email: 'fan@example.com' };
    const err = await likePage('draft-app').catch((e) => e);
    expect((err as { init?: { status?: number } }).init?.status).toBe(404);
  });

  it('back: only a GALLERY_FRAME_ANCESTORS origin', () => {
    expect(safeGalleryBack('https://www.example.test/gallery?q=x')).toBe('https://www.example.test/gallery?q=x');
    expect(safeGalleryBack('https://evil.example/gallery')).toBeNull();
    expect(safeGalleryBack('javascript:alert(1)')).toBeNull();
    expect(safeGalleryBack('/gallery')).toBeNull();
    expect(safeGalleryBack(null)).toBeNull();
  });
});

describe('GET /api/public/gallery — likes, opens and sort=popular', () => {
  it('each item carries likes, opens, openUrl and likeUrl; sort=popular is page mode', async () => {
    const res = await galleryLoader({ request: new Request('https://drobek.example/api/public/gallery'), params: {}, context: {} } as never);
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    expect(body.items[0]).toMatchObject({
      name: 'Shift planner',
      openUrl: 'https://drobek.example/gallery/open/shift-plan',
      likeUrl: 'https://drobek.example/gallery/like/shift-plan',
    });
    expect(typeof body.items[0].likes).toBe('number');
    expect(typeof body.items[0].opens).toBe('number');
    const popular = await galleryLoader({
      request: new Request('https://drobek.example/api/public/gallery?sort=popular'),
      params: {},
      context: {},
    } as never);
    expect(await popular.json()).toMatchObject({ page: 1, total: 1 });
  });
});
