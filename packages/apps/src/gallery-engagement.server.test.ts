/**
 * Gallery likes and opens on a real (PGlite) database: only a
 * visible entry resolves; opens count per UTC day and the list shows the
 * last 30 days; a like is one per account, idempotent, removable; deleting
 * the account drops its like; `sort=popular` orders by 5 × likes + opens.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { galleryOpens, users, workspaces } from '@drobek/db';
import {
  createApp,
  createVersion,
  galleryEntryBySlug,
  galleryLikeState,
  gallerySort,
  isPrefetchRequest,
  listGallery,
  listGalleryPage,
  publish,
  recordGalleryOpen,
  setGalleryLike,
  setGalleryListing,
  unpublishApp,
  type Actor,
} from './index.js';
import { freshDb, type TestDb } from './test/db.js';

const ON = { GALLERY_ENABLED: 'true', APPS_DOMAIN: 'apps.example.test', APPS_URL_SCHEME: 'https' } as NodeJS.ProcessEnv;
const NOW = new Date('2026-09-27T12:00:00Z');
const DAY = 86_400_000;

let db: TestDb;
let close: () => Promise<void>;
let wsId: string;
let actor: Actor;
const people: string[] = [];

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const [u] = await db.insert(users).values({ email: 'owner@example.test' }).returning();
  for (let i = 0; i < 3; i++) {
    const [p] = await db.insert(users).values({ email: `fan${i}@example.test` }).returning();
    people.push(p.id);
  }
  const [w] = await db.insert(workspaces).values({ kind: 'personal', slug: 'owner', name: 'Owner' }).returning();
  wsId = w.id;
  actor = { userId: u.id, kind: 'user' };
});
afterAll(async () => close());

let n = 0;
async function listedApp(name: string): Promise<{ id: string; slug: string }> {
  n += 1;
  const app = await createApp({ workspaceId: wsId, slug: `eng-${n}`, name, actor });
  const v = await createVersion(app.id, [{ path: 'index.html', content: 'x' }], { actor, compile: { status: 'ok' } });
  await publish(app.id, v.id, actor, { screen: false });
  await setGalleryListing(app.id, { listed: true, description: `${name} does one thing.` }, actor, { env: ON });
  return app;
}

async function itemOf(slug: string) {
  const { items } = await listGallery({ limit: 48, env: ON, now: NOW });
  return items.find((i) => i.url === `https://${slug}.apps.example.test`)!;
}

describe('galleryEntryBySlug', () => {
  it('resolves a visible entry only', async () => {
    const app = await listedApp('Visible');
    expect(await galleryEntryBySlug(app.slug, ON)).toMatchObject({
      id: app.id,
      slug: app.slug,
      name: 'Visible',
      url: `https://${app.slug}.apps.example.test`,
    });
    expect(await galleryEntryBySlug('no-such-app', ON)).toBeNull();
    expect(await galleryEntryBySlug('Bad Slug', ON)).toBeNull();
    await unpublishApp(app.id, actor);
    expect(await galleryEntryBySlug(app.slug, ON)).toBeNull();
  });
});

describe('opens', () => {
  it('count per UTC day; the list sums the last 30 days', async () => {
    const app = await listedApp('Opened');
    await recordGalleryOpen(app.id, NOW);
    await recordGalleryOpen(app.id, NOW);
    await recordGalleryOpen(app.id, new Date(NOW.getTime() - 29 * DAY));
    await recordGalleryOpen(app.id, new Date(NOW.getTime() - 30 * DAY));
    const rows = await db.select().from(galleryOpens).where(eq(galleryOpens.appId, app.id));
    expect(rows.map((r) => [r.day, r.count]).sort()).toEqual([
      ['2026-08-28', 1],
      ['2026-08-29', 1],
      ['2026-09-27', 2],
    ]);
    expect((await itemOf(app.slug)).opens).toBe(3);
  });

  it('prefetch and preview requests are recognized', () => {
    expect(isPrefetchRequest(new Headers({ 'Sec-Purpose': 'prefetch;prerender' }))).toBe(true);
    expect(isPrefetchRequest(new Headers({ Purpose: 'prefetch' }))).toBe(true);
    expect(isPrefetchRequest(new Headers({ 'X-Moz': 'prefetch' }))).toBe(true);
    expect(isPrefetchRequest(new Headers({ 'X-Purpose': 'preview' }))).toBe(true);
    expect(isPrefetchRequest(new Headers({ Accept: 'text/html' }))).toBe(false);
  });
});

describe('likes', () => {
  it('one per account, idempotent, removable; a deleted account drops its like', async () => {
    const app = await listedApp('Liked');
    expect(await galleryLikeState(app.id, people[0])).toEqual({ likes: 0, liked: false });
    expect(await setGalleryLike(app.id, people[0], true)).toEqual({ likes: 1, liked: true });
    expect(await setGalleryLike(app.id, people[0], true)).toEqual({ likes: 1, liked: true });
    expect(await setGalleryLike(app.id, people[1], true)).toEqual({ likes: 2, liked: true });
    expect(await galleryLikeState(app.id, people[2])).toEqual({ likes: 2, liked: false });
    expect(await galleryLikeState(app.id, null)).toEqual({ likes: 2, liked: false });
    expect((await itemOf(app.slug)).likes).toBe(2);
    expect(await setGalleryLike(app.id, people[0], false)).toEqual({ likes: 1, liked: false });
    expect(await setGalleryLike(app.id, people[0], false)).toEqual({ likes: 1, liked: false });
    await db.delete(users).where(eq(users.id, people[1]));
    expect(await galleryLikeState(app.id, null)).toEqual({ likes: 0, liked: false });
  });
});

describe('sort=popular', () => {
  it('orders by 5 × likes + opens in the window, ties newest first', async () => {
    expect(gallerySort('popular')).toBe('popular');
    expect(gallerySort(' Popular ')).toBe('popular');
    const quiet = await listedApp('Popq quiet');
    const opened = await listedApp('Popq opened');
    const liked = await listedApp('Popq liked');
    for (let i = 0; i < 4; i++) await recordGalleryOpen(opened.id, NOW);
    await setGalleryLike(liked.id, people[2], true);
    await recordGalleryOpen(quiet.id, new Date(NOW.getTime() - 40 * DAY));
    const page = await listGalleryPage({ limit: 10, page: 1, q: 'popq', sort: 'popular', env: ON, now: NOW });
    expect(page.items.map((i) => i.name)).toEqual(['Popq liked', 'Popq opened', 'Popq quiet']);
    expect(page.items.map((i) => [i.likes, i.opens])).toEqual([
      [1, 0],
      [0, 4],
      [0, 0],
    ]);
    expect(page.total).toBe(3);
  });
});
