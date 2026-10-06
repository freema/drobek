/**
 * Feedback in the dashboard against a real PGlite database (the session and
 * the workspace role gate are stubbed — they have their own tests):
 *
 *  - /feedback/new: signed out → login with returnTo; a non-member and an
 *    unknown app answer the same 404; the page cleans what the widget passed
 *    and never takes the note's text from the URL; a POST stores the note,
 *    429 past the hourly limit; the page cannot be framed.
 *  - the Feedback tab: open / resolved / all with counts and the empty states;
 *    resolve and reopen need editor+; delete only the author or a workspace
 *    admin.
 */
import { fileURLToPath } from 'node:url';
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

let pg: PGlite;
const db = () => drizzle(pg, { schema });
let appId = '';
const people = {} as Record<'vera' | 'ed' | 'ada', { id: string; email: string }>;

const status = (res: unknown) => (res instanceof Response ? res.status : ((res as { init: { status: number } | null }).init?.status ?? 200));
const body = <T,>(res: unknown) => (res && typeof res === 'object' && 'data' in res ? (res as { data: T }).data : (res as T));
const thrown = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

const NEW = 'https://drobek.example/feedback/new';
const openPopup = (query: string) => popup.loader({ request: new Request(`${NEW}?${query}`), params: {}, context: {} } as never);
const sendNote = (fields: Record<string, string>) =>
  popup.action({ request: new Request(NEW, { method: 'POST', body: new URLSearchParams(fields) }), params: {}, context: {} } as never);

const TAB = 'https://drobek.example/workspaces/acme/apps/shop/feedback';
const tabParams = { slug: 'acme', appSlug: 'shop' };
const loadTab = (query = '') => tab.loader({ request: new Request(`${TAB}${query}`), params: tabParams, context: {} } as never);
const postTab = (fields: Record<string, string>) =>
  tab.action({ request: new Request(TAB, { method: 'POST', body: new URLSearchParams(fields) }), params: tabParams, context: {} } as never);

beforeAll(async () => {
  pg = new PGlite();
  await migrate(db(), {
    migrationsFolder: fileURLToPath(new URL('../../../db/drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_core',
    migrationsSchema: 'drizzle',
  });
  setDbForTests(db());
  for (const k of ['vera', 'ed', 'ada'] as const) {
    const [u] = await db().insert(users).values({ email: `${k}@example.com` }).returning();
    people[k] = { id: u.id, email: u.email };
  }
  const [w] = await db().insert(workspaces).values({ kind: 'team', slug: 'acme', name: 'Acme' }).returning();
  s.ws = { ...s.ws, id: w.id };
  const [a] = await db().insert(apps).values({ workspaceId: w.id, slug: 'shop', name: 'Shop' }).returning();
  appId = a.id;
  process.env.APPS_DOMAIN = 'apps.example';
  process.env.PUBLIC_APP_URL = 'https://drobek.example';
});

afterAll(async () => {
  await pg.close();
});

beforeEach(() => {
  s.user = people.vera;
  s.role = 'viewer';
  s.member = true;
  delete process.env.FEEDBACK_PER_USER_HOUR;
});

describe('/feedback/new', () => {
  it('signed out → the login page, coming back here afterwards', async () => {
    s.user = null;
    const res = (await thrown(openPopup('app=shop&v=2&path=/cart'))) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`/login?returnTo=${encodeURIComponent('/feedback/new?app=shop&v=2&path=/cart')}`);
  });

  it('an unknown app and a workspace the account is not in answer the same 404', async () => {
    expect(status(await thrown(openPopup('app=nope')))).toBe(404);
    s.member = false;
    expect(status(await thrown(openPopup('app=shop')))).toBe(404);
    expect(status(await thrown(openPopup('app=../etc')))).toBe(404);
  });

  it('a viewer gets the form with the cleaned context and no text from the URL; the page cannot be framed', async () => {
    const res = await openPopup('app=shop&v=3&path=/cart%3Fx%3D1&x=120&y=640&vw=1280&vh=800&sel=main%20%3E%20h1&body=Do%20this');
    const d = body<Awaited<ReturnType<typeof popup.loader>>['data']>(res);
    expect(d.app).toEqual({ slug: 'shop', name: 'Shop' });
    expect(d.context).toMatchObject({
      version: 3,
      path: '/cart',
      anchor: { selector: 'main > h1', x: 120, y: 640, vw: 1280, vh: 800 },
      spot: 'x 120, y 640 in a 1280×800 window — main > h1',
      pageUrl: 'https://shop--v3.apps.example/cart',
    });
    expect(JSON.stringify(d)).not.toContain('Do this');
    const h = popup.headers({ actionHeaders: new Headers(), loaderHeaders: new Headers() } as never);
    expect(h.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
    expect(h.get('X-Frame-Options')).toBe('DENY');
  });

  it('a POST stores the note as the signed-in member; an empty one is refused', async () => {
    expect(status(await sendNote({ app: 'shop', body: '   ' }))).toBe(400);
    const res = await sendNote({ app: 'shop', v: '3', path: '/cart', x: '1', y: '2', vw: '300', vh: '400', body: 'The total is wrong.' });
    const r = body<{ ok: boolean; id: string }>(res);
    expect(r.ok).toBe(true);
    const [row] = await db().select().from(appFeedback).where(eq(appFeedback.id, r.id));
    expect(row).toMatchObject({ appId, authorUserId: people.vera.id, versionNumber: 3, path: '/cart', body: 'The total is wrong.', status: 'open' });
    expect(row.anchor).toEqual({ x: 1, y: 2, vw: 300, vh: 400 });
  });

  it('a non-member cannot post either', async () => {
    s.member = false;
    expect(status(await thrown(sendNote({ app: 'shop', body: 'x' })))).toBe(404);
  });

  it('past FEEDBACK_PER_USER_HOUR → 429 with Retry-After, the text kept for another try', async () => {
    process.env.FEEDBACK_PER_USER_HOUR = '1';
    s.user = people.ada;
    expect(body<{ ok: boolean }>(await sendNote({ app: 'shop', body: 'first' })).ok).toBe(true);
    const res = await sendNote({ app: 'shop', body: 'second' });
    expect(status(res)).toBe(429);
    expect(body<{ ok: boolean; body: string }>(res)).toMatchObject({ ok: false, body: 'second' });
    expect(Number((res as { init: { headers: Record<string, string> } }).init.headers['Retry-After'])).toBeGreaterThan(0);
  });
});

describe('the Feedback tab', () => {
  it('lists open notes with counts; viewers cannot resolve', async () => {
    const d = await loadTab();
    expect(d.status).toBe('open');
    expect(d.counts).toEqual({ open: 2, resolved: 0 });
    expect(d.canResolve).toBe(false);
    expect(d.rows.map((r) => r.body)).toEqual(['first', 'The total is wrong.']);
    expect(d.rows[1]).toMatchObject({ author: 'vera@example.com', version: 3, path: '/cart', openUrl: 'https://shop--v3.apps.example/cart', canDelete: true });
    expect(d.rows[0]).toMatchObject({ author: 'ada@example.com', version: null, openUrl: 'https://shop--preview.apps.example/', canDelete: false });
    expect(status(await postTab({ intent: 'resolve', id: d.rows[0].id }))).toBe(403);
  });

  it('an editor resolves with a note and reopens; the filters follow', async () => {
    s.user = people.ed;
    s.role = 'editor';
    const [first] = (await loadTab()).rows;
    expect(status(await postTab({ intent: 'resolve', id: first.id, note: 'Fixed the total.', status: 'open' }))).toBe(302);
    const resolved = await loadTab('?status=resolved');
    expect(resolved.rows).toEqual([expect.objectContaining({ id: first.id, status: 'resolved', resolvedBy: 'ed@example.com', resolutionNote: 'Fixed the total.' })]);
    expect((await loadTab('?status=all')).rows).toHaveLength(2);
    expect(status(await postTab({ intent: 'reopen', id: first.id }))).toBe(302);
    expect((await loadTab()).counts).toEqual({ open: 2, resolved: 0 });
    const actions = await db().select({ a: auditLog.action }).from(auditLog);
    expect(actions.map((x) => x.a)).toEqual(expect.arrayContaining(['app.feedback.create', 'app.feedback.resolve', 'app.feedback.reopen']));
  });

  it('delete: not an editor who did not write it, yes the author and a workspace admin', async () => {
    s.user = people.ed;
    s.role = 'editor';
    const rows = (await loadTab()).rows;
    const vera = rows.find((r) => r.author === 'vera@example.com')!;
    const ada = rows.find((r) => r.author === 'ada@example.com')!;
    expect(status(await postTab({ intent: 'delete', id: vera.id }))).toBe(403);
    s.user = people.vera;
    s.role = 'viewer';
    expect(status(await postTab({ intent: 'delete', id: vera.id }))).toBe(302);
    s.user = people.ed;
    s.role = 'workspace-admin';
    expect(status(await postTab({ intent: 'delete', id: ada.id }))).toBe(302);
    expect(status(await postTab({ intent: 'delete', id: ada.id }))).toBe(404);
  });

  it('distinguishes no notes at all, all resolved, and a page that cannot be read', async () => {
    const empty = await loadTab();
    expect(empty.rows).toEqual([]);
    expect(empty.counts).toEqual({ open: 0, resolved: 0 });
    const stale = await loadTab(`?before=fb_${'0'.repeat(24)}`);
    expect(stale.error).toContain('no longer exists');
  });
});
