/**
 * Gallery likes and opens (NSO-340), behind the dashboard's
 * `/gallery/open/<slug>` (the counting link the public list hands out) and
 * `/gallery/like/<slug>` (a signed-in account likes or unlikes an app).
 *
 * Opens are one counter per app and UTC day, with nothing about who opened
 * the app; a like is one row per account and app. Only an entry the public
 * list shows right now can be opened or liked; deleting an app or an account
 * removes its rows (FK cascade).
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import { apps, galleryLikes, galleryOpens, getDb } from '@drobek/db';
import { galleryOpensSince, utcDay } from './gallery.js';
import { visibleInGallery } from './gallery.server.js';
import { publishedUrl } from './origin.js';

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** An entry the public gallery shows right now. */
export interface GalleryEntry {
  id: string;
  slug: string;
  name: string;
  description: string;
  /** The production URL. */
  url: string;
}

/** The visible gallery entry with this slug, or null (unknown, unlisted, unpublished, hidden, taken down, deleted). */
export async function galleryEntryBySlug(slug: string, env?: NodeJS.ProcessEnv): Promise<GalleryEntry | null> {
  if (!SLUG_RE.test(slug) || slug.length > 40) return null;
  const [row] = await getDb()
    .select({ id: apps.id, slug: apps.slug, name: apps.name, description: apps.galleryDescription })
    .from(apps)
    .where(and(eq(apps.slug, slug), ...visibleInGallery()))
    .limit(1);
  if (!row) return null;
  return { id: row.id, slug: row.slug, name: row.name ?? row.slug, description: row.description ?? '', url: publishedUrl(row.slug, env) };
}

/** Count one open of the app for the UTC day of `now`. */
export async function recordGalleryOpen(appId: string, now: Date = new Date()): Promise<void> {
  await getDb()
    .insert(galleryOpens)
    .values({ appId, day: utcDay(now), count: 1 })
    .onConflictDoUpdate({ target: [galleryOpens.appId, galleryOpens.day], set: { count: sql`${galleryOpens.count} + 1` } });
}

/** An app's likes and its opens in the last GALLERY_OPENS_WINDOW_DAYS UTC days (what its gallery entry shows). */
export async function galleryCounts(appId: string, now: Date = new Date()): Promise<{ likes: number; opens: number }> {
  const [[likes], [opens]] = await Promise.all([
    getDb().select({ n: sql<number>`count(*)::int` }).from(galleryLikes).where(eq(galleryLikes.appId, appId)),
    getDb()
      .select({ n: sql<number>`coalesce(sum(${galleryOpens.count}), 0)::int` })
      .from(galleryOpens)
      .where(and(eq(galleryOpens.appId, appId), gte(galleryOpens.day, galleryOpensSince(now)))),
  ]);
  return { likes: Number(likes?.n ?? 0), opens: Number(opens?.n ?? 0) };
}

/** How many accounts like the app, and whether `userId` is one of them. */
export async function galleryLikeState(appId: string, userId: string | null): Promise<{ likes: number; liked: boolean }> {
  const [row] = await getDb()
    .select({
      likes: sql<number>`count(*)::int`,
      liked: userId === null ? sql<boolean>`false` : sql<boolean>`coalesce(bool_or(${galleryLikes.userId} = ${userId}), false)`,
    })
    .from(galleryLikes)
    .where(eq(galleryLikes.appId, appId));
  return { likes: Number(row?.likes ?? 0), liked: row?.liked === true };
}

/** Like (`liked: true`) or unlike the app for the account; idempotent. Returns the new state. */
export async function setGalleryLike(appId: string, userId: string, liked: boolean): Promise<{ likes: number; liked: boolean }> {
  if (liked) {
    await getDb().insert(galleryLikes).values({ appId, userId }).onConflictDoNothing();
  } else {
    await getDb().delete(galleryLikes).where(and(eq(galleryLikes.appId, appId), eq(galleryLikes.userId, userId)));
  }
  return galleryLikeState(appId, userId);
}
