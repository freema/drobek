/**
 * NSO-340 in the dashboard, on a real PGlite database (the workspace role
 * gate is stubbed — requireWorkspaceRole has its own tests in
 * @drobek/tenancy; the stub answers 403 for a viewer at the editor floor
 * like the real one):
 *  - appAction `gallery`: an editor lists a published app / relists with a new
 *    description / unlists; a viewer gets 403 before anything changes; an
 *    unpublished app and a bad description come back as 400; a server without
 *    a gallery answers 404;
 *  - GET /api/public/gallery: 404 unless GALLERY_ENABLED; the listed app with
 *    name / description / url / publishedAt and nothing else; CORS * +
 *    `public, max-age=60`; the per-IP limit (429 + Retry-After; a Redis
 *    failure lets the request through); every other method → 405.
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@drobek/db/schema';
import { appVersions, apps, auditLog, setDbForTests, users, workspaces } from '@drobek/db';

const role = vi.hoisted(() => ({
  user: { id: '', email: 'owner@example.com' },
  ws: { id: '', slug: 'acme', name: 'Acme' },
  effective: 'editor' as 'editor' | 'viewer',
}));

vi.mock('@drobek/tenancy', () => ({
  requireWorkspaceRole: async (_request: Request, slug: string, minRole: string) => {
    if (slug !== role.ws.slug) throw new Response('Not found', { status: 404 });
    if (minRole === 'editor' && role.effective === 'viewer') throw new Response('Forbidden', { status: 403 });
    return { user: role.user, workspace: role.ws, membershipRole: role.effective, superAdmin: false, effectiveRole: role.effective };
  },
}));

const rateLimitRedis = vi.hoisted(() =>
  vi.fn(async (_bucket: string, _key: string, _limit: number, _windowMs: number) => ({ ok: true }))
);
vi.mock('@drobek/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@drobek/auth')>();
  return { ...actual, rateLimitRedis: (...a: Parameters<typeof rateLimitRedis>) => rateLimitRedis(...a) };
});

const { appAction } = await import('./app-page.server.js');
const { action: galleryAction, loader: galleryLoader, GALLERY_RATE_BUCKET } = await import('./routes/api.public.gallery.server.js');

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let appId: string;

function post(appSlug: string, body: Record<string, string>) {
  const request = new Request(`https://drobek.example/workspaces/acme/apps/${appSlug}`, {
    method: 'POST',
    body: new URLSearchParams(body),
  });
  return appAction({ request, params: { slug: 'acme', appSlug }, context: {} } as never);
}

function failed(res: unknown): { status: number; error: string } {
  const d = res as { data: { error: string }; init: { status: number } };
  return { status: d.init?.status, error: d.data.error };
}

function isRedirect(res: unknown): boolean {
  return res instanceof Response && res.status === 302;
}

function getGallery(query = '', headers: Record<string, string> = {}) {
  const request = new Request(`https://drobek.example/api/public/gallery${query}`, { headers });
  return galleryLoader({ request, params: {}, context: {} } as never);
}

async function row() {
  const [r] = await db.select().from(apps).where(eq(apps.id, appId));
  return r;
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
  role.user = { id: u.id, email: u.email };
  const [w] = await db.insert(workspaces).values({ kind: 'team', slug: 'acme', name: 'Acme' }).returning();
  role.ws = { id: w.id, slug: w.slug, name: w.name };
  const [a] = await db.insert(apps).values({ workspaceId: w.id, slug: 'shift-plan', name: 'Shift planner' }).returning();
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
  role.effective = 'editor';
  rateLimitRedis.mockReset();
  rateLimitRedis.mockImplementation(async () => ({ ok: true }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('appAction intent=gallery (NSO-340)', () => {
  it('a viewer gets 403 before anything changes', async () => {
    role.effective = 'viewer';
    const err = await post('shift-plan', { intent: 'gallery', listed: 'on', description: 'Plans shifts.' }).catch((e) => e);
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(403);
    expect((await row()).galleryListed).toBe(false);
  });

  it('an unpublished app and a bad description answer 400 with a caller-safe message', async () => {
    const unpub = failed(await post('draft-app', { intent: 'gallery', listed: 'on', description: 'A draft.' }));
    expect(unpub.status).toBe(400);
    expect(unpub.error).toMatch(/publish it first/);
    const empty = failed(await post('shift-plan', { intent: 'gallery', listed: 'on', description: '   ' }));
    expect(empty.status).toBe(400);
    const long = failed(await post('shift-plan', { intent: 'gallery', listed: 'on', description: 'x'.repeat(161) }));
    expect(long.status).toBe(400);
    expect(long.error).toMatch(/160/);
  });

  it('without GALLERY_ENABLED the switch is not there (404)', async () => {
    vi.stubEnv('GALLERY_ENABLED', '');
    expect(failed(await post('shift-plan', { intent: 'gallery', listed: 'on', description: 'Plans shifts.' })).status).toBe(404);
  });

  it('an editor lists, changes the description and unlists — each audited, actor_kind user', async () => {
    expect(isRedirect(await post('shift-plan', { intent: 'gallery', listed: 'on', description: 'Plans shifts.' }))).toBe(true);
    expect(await row()).toMatchObject({ galleryListed: true, galleryDescription: 'Plans shifts.' });
    expect(isRedirect(await post('shift-plan', { intent: 'gallery', listed: 'on', description: 'Plans shifts for teams.' }))).toBe(
      true
    );
    expect((await row()).galleryDescription).toBe('Plans shifts for teams.');
    expect(isRedirect(await post('shift-plan', { intent: 'gallery', description: 'Plans shifts for teams.' }))).toBe(true);
    expect((await row()).galleryListed).toBe(false);
    const audit = await db.select().from(auditLog).where(eq(auditLog.target, 'shift-plan')).orderBy(auditLog.createdAt);
    expect(audit.map((a) => a.action)).toEqual(['app.gallery_listed', 'app.gallery_listed', 'app.gallery_unlisted']);
    expect(new Set(audit.map((a) => a.actorKind))).toEqual(new Set(['user']));
  });
});

describe('GET /api/public/gallery (NSO-340)', () => {
  it('404 unless GALLERY_ENABLED (CORS headers on the error too)', async () => {
    vi.stubEnv('GALLERY_ENABLED', '0');
    const res = await getGallery();
    expect(res.status).toBe(404);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });

  it('lists the listed app — name, description, url, publishedAt only; public cache + CORS *', async () => {
    await post('shift-plan', { intent: 'gallery', listed: 'on', description: 'Plans shifts.' });
    const res = await getGallery('', { 'x-real-ip': '203.0.113.9' });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { items: Record<string, unknown>[]; next?: string };
    expect(body).toEqual({
      items: [
        {
          name: 'Shift planner',
          description: 'Plans shifts.',
          url: 'https://shift-plan.apps.example.test',
          publishedAt: '2026-09-20T10:00:00.000Z',
        },
      ],
    });
    const text = JSON.stringify(body);
    for (const secret of [appId, role.ws.id, role.ws.slug, role.user.id, role.user.email]) expect(text).not.toContain(secret);
    expect(rateLimitRedis).toHaveBeenCalledWith(GALLERY_RATE_BUCKET, '203.0.113.9', 60, 60_000);
  });

  it('pages with ?limit and the next cursor', async () => {
    const [w] = await db.select().from(workspaces).where(eq(workspaces.slug, 'acme'));
    for (let i = 0; i < 3; i += 1) {
      const [a] = await db
        .insert(apps)
        .values({
          workspaceId: w.id,
          slug: `more-${i}`,
          galleryListed: true,
          galleryDescription: `More ${i}.`,
          publishedAt: new Date(Date.UTC(2026, 8, 21 + i)),
        })
        .returning();
      const [v] = await db.insert(appVersions).values({ appId: a.id, number: 1, compileStatus: 'ok', actorKind: 'agent' }).returning();
      await db.update(apps).set({ publishedVersionId: v.id }).where(eq(apps.id, a.id));
    }
    const first = (await (await getGallery('?limit=2')).json()) as { items: { url: string; name: string }[]; next?: string };
    expect(first.items.map((i) => i.name)).toEqual(['more-2', 'more-1']);
    expect(first.next).toBeTruthy();
    const second = (await (await getGallery(`?limit=2&cursor=${first.next}`)).json()) as { items: { name: string }[]; next?: string };
    expect(second.items.map((i) => i.name)).toEqual(['more-0', 'Shift planner']);
    expect(second.next).toBeUndefined();
  });

  it('over the per-IP limit → 429 + Retry-After; no client IP → not counted; Redis down → allowed', async () => {
    rateLimitRedis.mockImplementation(async () => ({ ok: false }));
    const limited = await getGallery('', { 'x-real-ip': '203.0.113.9' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(limited.headers.get('access-control-allow-origin')).toBe('*');

    rateLimitRedis.mockClear();
    expect((await getGallery()).status).toBe(200);
    expect(rateLimitRedis).not.toHaveBeenCalled();

    rateLimitRedis.mockImplementation(async () => {
      throw new Error('redis down');
    });
    expect((await getGallery('', { 'x-real-ip': '203.0.113.9' })).status).toBe(200);
  });

  it('is read-only: any other method → 405', async () => {
    const res = await galleryAction();
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });
});
