/**
 * The public gallery, the stateful half:
 *
 *  - `setGalleryListing` — an editor+ lists a PUBLISHED app with a short
 *    public description, changes the description, or unlists it. The same
 *    function serves the dashboard (the app's Overview) and the MCP tool
 *    `set_gallery_listing` (which additionally demands the user's explicit
 *    yes). Audited `app.gallery_listed` / `app.gallery_unlisted`.
 *  - `setGalleryHidden` — a super-admin hides an entry (or shows it again);
 *    a hidden app cannot be listed by anyone. Audited `app.gallery_hidden` /
 *    `app.gallery_unhidden`.
 *  - `listGallery` (cursor pages) / `listGalleryPage` (numbered pages, sort by
 *    newest or name; both searchable) — the public list behind
 *    `GET /api/public/gallery`: name, description, production URL, publish
 *    time, configured module names, whether it may be duplicated (and the
 *    dashboard link that does it) and how many copies exist — never config,
 *    an owner, workspace or id. It filters at QUERY time
 *    (listed AND published AND public AND not taken down AND not deleted AND
 *    not hidden), so an unpublish, a takedown or a delete takes the entry off
 *    the list with the very next request, whatever the flag says. unpublishApp / takedownApp also clear the flag
 *    (the owner lists again after publishing again).
 *
 * GALLERY_ENABLED (default off) gates every change here; the public endpoint
 * checks it itself. A listing change and a hide / show announce an
 * app-changed `settings` event: the app hosts' cache drops the app, so the
 * gallery's frame permission (GALLERY_FRAME_ANCESTORS) follows at once.
 */
import { and, asc, desc, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { AUDIT_ACTIONS, writeAudit, type AuditActorKind } from '@drobek/audit';
import { apps, galleryLikes, galleryOpens, getDb, moduleConfigs, workspaces } from '@drobek/db';
import { AppsError } from './errors.js';
import { notifyAppChanged } from './events.js';
import {
  GALLERY_PAGE_SIZE,
  GALLERY_POPULAR_LIKE_WEIGHT,
  decodeGalleryCursor,
  encodeGalleryCursor,
  galleryEnabled,
  galleryLikePattern,
  galleryOpensSince,
  galleryQuery,
  normalizeGalleryDescription,
  type GallerySort,
} from './gallery.js';
import { lockedByAdminError } from './moderation.server.js';
import { dashboardOrigin, publishedUrl } from './origin.js';
import type { Actor } from './types.js';

/** The dashboard page where a signed-in person duplicates the gallery app `slug`. */
export function duplicatePageUrl(slug: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${dashboardOrigin(env)}/duplicate/${encodeURIComponent(slug)}`;
}

function refuseWhenDisabled(env: NodeJS.ProcessEnv): void {
  if (!galleryEnabled(env)) {
    throw new AppsError('gallery_disabled', 'The public gallery is turned off on this server.');
  }
}

export type GalleryListingInput = { listed: true; description: string; allowDuplicate?: boolean } | { listed: false };

export interface GalleryListingResult {
  /** false = the app already was in that state (nothing written, no audit). */
  changed: boolean;
  listed: boolean;
  description: string | null;
  /** The owner lets signed-in people duplicate the app (kept while unlisted, like the description). */
  allowDuplicate: boolean;
  slug: string;
}

/**
 * List / relist with a new description / unlist one app. Listing refuses:
 * the gallery off (`gallery_disabled`), a taken-down app
 * (`app_locked_by_admin`), an entry a super-admin hid (`gallery_hidden`), an
 * unpublished app (`not_published`) and a bad description
 * (`invalid_settings`, the caller-safe message). Unlisting always works
 * (while the gallery is on); unlisting an unlisted app is a no-op. The
 * description stays stored on unlist, so listing again can reuse it.
 */
export async function setGalleryListing(
  appId: string,
  input: GalleryListingInput,
  actor: Actor,
  opts: { env?: NodeJS.ProcessEnv } = {}
): Promise<GalleryListingResult> {
  refuseWhenDisabled(opts.env ?? process.env);
  let description: string | null = null;
  if (input.listed) {
    const v = normalizeGalleryDescription(input.description);
    if (!v.ok) throw new AppsError('invalid_settings', v.message);
    description = v.value;
  }
  const out = await getDb().transaction(async (tx): Promise<GalleryListingResult> => {
    const [app] = await tx
      .select({
        id: apps.id,
        slug: apps.slug,
        workspaceId: apps.workspaceId,
        publishedVersionId: apps.publishedVersionId,
        lockedReason: apps.lockedReason,
        galleryListed: apps.galleryListed,
        galleryDescription: apps.galleryDescription,
        galleryHiddenAt: apps.galleryHiddenAt,
        galleryAllowDuplicate: apps.galleryAllowDuplicate,
      })
      .from(apps)
      .where(and(eq(apps.id, appId), isNull(apps.deletedAt)))
      .for('update');
    if (!app) throw new AppsError('not_found', `App ${appId} does not exist.`);
    const allowDuplicate = input.listed ? (input.allowDuplicate ?? app.galleryAllowDuplicate) : app.galleryAllowDuplicate;
    const audit = (action: string, meta: Record<string, unknown>) =>
      writeAudit(
        {
          workspaceId: app.workspaceId,
          actorUserId: actor.userId,
          actorKind: actor.kind,
          action,
          subjectType: 'app',
          target: app.slug,
          meta,
        },
        tx
      );

    if (!input.listed) {
      if (!app.galleryListed) return { changed: false, listed: false, description: app.galleryDescription, allowDuplicate, slug: app.slug };
      await tx.update(apps).set({ galleryListed: false }).where(eq(apps.id, app.id));
      await audit(AUDIT_ACTIONS.appGalleryUnlisted, { reason: 'owner' });
      return { changed: true, listed: false, description: app.galleryDescription, allowDuplicate, slug: app.slug };
    }

    if (app.lockedReason) throw lockedByAdminError(app.lockedReason);
    if (app.galleryHiddenAt) {
      throw new AppsError(
        'gallery_hidden',
        'The server operator hid this app from the public gallery, so it cannot be listed there. Contact the operator if you think this is a mistake.'
      );
    }
    if (!app.publishedVersionId) {
      throw new AppsError('not_published', 'Only a published app can be listed in the gallery — publish it first.');
    }
    if (app.galleryListed && app.galleryDescription === description && app.galleryAllowDuplicate === allowDuplicate) {
      return { changed: false, listed: true, description, allowDuplicate, slug: app.slug };
    }
    await tx
      .update(apps)
      .set({ galleryListed: true, galleryDescription: description, galleryAllowDuplicate: allowDuplicate })
      .where(eq(apps.id, app.id));
    await audit(AUDIT_ACTIONS.appGalleryListed, {
      description,
      allowDuplicate,
      ...(app.galleryListed ? { previousDescription: app.galleryDescription, previousAllowDuplicate: app.galleryAllowDuplicate } : {}),
    });
    return { changed: true, listed: true, description, allowDuplicate, slug: app.slug };
  });
  if (out.changed) await notifyAppChanged({ app_id: appId, slug: out.slug, kind: 'settings' });
  return out;
}

/**
 * A super-admin hides an app's gallery entry (`hidden: true`) or shows it
 * again. Independent of the owner's flag: a hidden app stays off the public
 * list and cannot be listed until it is shown again. Setting the state it
 * already has is a no-op (`changed: false`, no audit).
 */
export async function setGalleryHidden(
  appId: string,
  hidden: boolean,
  actorUserId: string,
  opts: { now?: Date; actorKind?: AuditActorKind } = {}
): Promise<{ changed: boolean; slug: string }> {
  const out = await getDb().transaction(async (tx) => {
    const [app] = await tx
      .select({ id: apps.id, slug: apps.slug, workspaceId: apps.workspaceId, galleryHiddenAt: apps.galleryHiddenAt })
      .from(apps)
      .where(and(eq(apps.id, appId), isNull(apps.deletedAt)))
      .for('update');
    if (!app) throw new AppsError('not_found', `App ${appId} does not exist.`);
    if ((app.galleryHiddenAt !== null) === hidden) return { changed: false, slug: app.slug };
    await tx
      .update(apps)
      .set({ galleryHiddenAt: hidden ? (opts.now ?? new Date()) : null })
      .where(eq(apps.id, app.id));
    await writeAudit(
      {
        workspaceId: app.workspaceId,
        actorUserId,
        actorKind: opts.actorKind ?? 'user',
        action: hidden ? AUDIT_ACTIONS.appGalleryHidden : AUDIT_ACTIONS.appGalleryUnhidden,
        subjectType: 'app',
        target: app.slug,
        meta: {},
      },
      tx
    );
    return { changed: true, slug: app.slug };
  });
  if (out.changed) await notifyAppChanged({ app_id: appId, slug: out.slug, kind: 'settings' });
  return out;
}

/** One public gallery entry — exactly what `GET /api/public/gallery` returns per app. */
export interface GalleryItem {
  name: string;
  description: string;
  /** The production URL `https://<slug>.<APPS_DOMAIN>`. */
  url: string;
  /** ISO 8601, when the production host last started serving a version. */
  publishedAt: string;
  /** Module names with a non-empty saved config; not pending proposals or a usage/availability claim. */
  modules: string[];
  /** The owner lets signed-in people duplicate the app into their own workspace. */
  duplicable: boolean;
  /** The dashboard page that duplicates it (sign-in first), null when not duplicable. */
  duplicateUrl: string | null;
  /** How many live apps were duplicated from this one. */
  duplicates: number;
  /** Signed-in drobek accounts that like the app. */
  likes: number;
  /** Opens through `openUrl` in the last GALLERY_OPENS_WINDOW_DAYS UTC days. */
  opens: number;
  /** The counting link to the app: `<dashboard>/gallery/open/<slug>` redirects to `url`. */
  openUrl: string;
  /** Where a signed-in account likes (or unlikes) the app: `<dashboard>/gallery/like/<slug>`. */
  likeUrl: string;
}

/** Listed AND published AND public AND not taken down AND not deleted AND not hidden. */
export function visibleInGallery(): SQL[] {
  return [
    eq(apps.galleryListed, true),
    isNotNull(apps.publishedVersionId),
    isNotNull(apps.publishedAt),
    isNotNull(apps.galleryDescription),
    eq(apps.visibility, 'public'),
    isNull(apps.lockedReason),
    isNull(apps.deletedAt),
    isNull(apps.galleryHiddenAt),
  ];
}

/** The visible entries, narrowed by a case- and accent-insensitive substring. */
function galleryWhere(q: string | null | undefined): SQL[] {
  const where = visibleInGallery();
  const text = galleryQuery(q);
  if (text) {
    const pattern = galleryLikePattern(text);
    where.push(
      sql`(regexp_replace(normalize(coalesce(${apps.name}, ${apps.slug}), NFD), '[\u0300-\u036f]', '', 'g') ILIKE ${pattern} ESCAPE '\\' OR regexp_replace(normalize(${apps.galleryDescription}, NFD), '[\u0300-\u036f]', '', 'g') ILIKE ${pattern} ESCAPE '\\')`
    );
  }
  return where;
}

function likesOf(): SQL<number> {
  return sql<number>`(select count(*)::int from ${galleryLikes} where ${galleryLikes.appId} = ${apps.id})`;
}

function opensOf(since: string): SQL<number> {
  return sql<number>`(select coalesce(sum(${galleryOpens.count}), 0)::int from ${galleryOpens}
    where ${galleryOpens.appId} = ${apps.id} and ${galleryOpens.day} >= ${since})`;
}

function itemColumns(now: Date) {
  return { ...baseColumns, likes: likesOf(), opens: opensOf(galleryOpensSince(now)) };
}

const baseColumns = {
  slug: apps.slug,
  name: apps.name,
  description: apps.galleryDescription,
  publishedAt: apps.publishedAt,
  // Names only, from the current saved configuration. A correlated aggregate
  // keeps pagination/counts intact and avoids a query per card. No extension
  // or module runtime dependency is needed by this public core API.
  modules: sql<string[]>`(select coalesce(jsonb_agg(${moduleConfigs.module} order by ${moduleConfigs.module}), '[]'::jsonb)
    from ${moduleConfigs} where ${moduleConfigs.appId} = ${apps.id}
    and jsonb_typeof(${moduleConfigs.config}) = 'object' and ${moduleConfigs.config} <> '{}'::jsonb)`,
  duplicable: apps.galleryAllowDuplicate,
  // Live copies; the alias keeps the outer "apps" row in reach of the subquery.
  duplicates: sql<number>`(select count(*)::int from "apps" as "copies" where "copies"."duplicated_from_app_id" = "apps"."id" and "copies"."deleted_at" is null)`,
};

/** The dashboard's counting link and like page for an app (both public paths, keyed by slug). */
export function galleryLinks(slug: string, env?: NodeJS.ProcessEnv): { openUrl: string; likeUrl: string } {
  const origin = dashboardOrigin(env);
  return { openUrl: `${origin}/gallery/open/${slug}`, likeUrl: `${origin}/gallery/like/${slug}` };
}

function toItem(
  r: {
    slug: string;
    name: string | null;
    description: string | null;
    publishedAt: Date | null;
    modules: string[];
    duplicable: boolean;
    duplicates: number;
    likes: number;
    opens: number;
  },
  env: NodeJS.ProcessEnv | undefined
): GalleryItem {
  return {
    name: r.name ?? r.slug,
    description: r.description ?? '',
    url: publishedUrl(r.slug, env),
    publishedAt: (r.publishedAt as Date).toISOString(),
    modules: r.modules,
    duplicable: r.duplicable,
    duplicateUrl: r.duplicable ? duplicatePageUrl(r.slug, env) : null,
    duplicates: Number(r.duplicates),
    likes: Number(r.likes),
    opens: Number(r.opens),
    ...galleryLinks(r.slug, env),
  };
}

/**
 * One page of the public gallery, newest publish first (ties by slug), and
 * the `next` cursor when more entries follow. A cursor that does not decode
 * starts at the first page. `q` narrows the list (see galleryWhere); the
 * cursor pages within the same `q`.
 */
export async function listGallery(
  opts: { limit?: number; cursor?: string | null; q?: string | null; env?: NodeJS.ProcessEnv; now?: Date } = {}
): Promise<{ items: GalleryItem[]; next: string | null }> {
  const limit = opts.limit ?? GALLERY_PAGE_SIZE;
  const cursor = decodeGalleryCursor(opts.cursor);
  const where = galleryWhere(opts.q);
  if (cursor) {
    where.push(sql`(${apps.publishedAt}, ${apps.slug}) < (${cursor.publishedAt.toISOString()}::timestamp, ${cursor.slug})`);
  }
  const rows = await getDb()
    .select(itemColumns(opts.now ?? new Date()))
    .from(apps)
    .where(and(...where))
    .orderBy(desc(apps.publishedAt), desc(apps.slug))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => toItem(r, opts.env)),
    next: rows.length > limit && last ? encodeGalleryCursor({ publishedAt: last.publishedAt as Date, slug: last.slug }) : null,
  };
}

/** One numbered page of the public gallery. */
export interface GalleryPage {
  items: GalleryItem[];
  /** The 1-based page these items are. */
  page: number;
  /** How many pages the filtered list has (0 when it is empty). */
  pages: number;
  /** How many entries the filtered list has. */
  total: number;
}

/**
 * Numbered pagination of the public gallery: page `page` (1-based) of `limit`
 * entries, the filtered total and the page count. `sort` = `new` (newest
 * publish first, ties by slug), `name` (name A→Z case-insensitively, ties
 * by slug) or `popular` (GALLERY_POPULAR_LIKE_WEIGHT × likes + opens in the
 * window, highest first; ties newest first); `q` narrows both the items and
 * the count. A page past the last one has no items (and still the right
 * `pages` / `total`).
 */
export async function listGalleryPage(
  opts: { limit?: number; page?: number; q?: string | null; sort?: GallerySort; env?: NodeJS.ProcessEnv; now?: Date } = {}
): Promise<GalleryPage> {
  const limit = opts.limit ?? GALLERY_PAGE_SIZE;
  const page = Math.max(1, Math.trunc(opts.page ?? 1));
  const where = and(...galleryWhere(opts.q));
  const now = opts.now ?? new Date();
  const order =
    opts.sort === 'name'
      ? [sql`lower(coalesce(${apps.name}, ${apps.slug})) ASC`, asc(apps.slug)]
      : opts.sort === 'popular'
        ? [
            sql`(${likesOf()} * ${GALLERY_POPULAR_LIKE_WEIGHT} + ${opensOf(galleryOpensSince(now))}) DESC`,
            desc(apps.publishedAt),
            desc(apps.slug),
          ]
        : [desc(apps.publishedAt), desc(apps.slug)];
  const [rows, [count]] = await Promise.all([
    getDb()
      .select(itemColumns(now))
      .from(apps)
      .where(where)
      .orderBy(...order)
      .limit(limit)
      .offset((page - 1) * limit),
    getDb().select({ total: sql<number>`count(*)::int` }).from(apps).where(where),
  ]);
  const total = Number(count?.total ?? 0);
  return { items: rows.map((r) => toItem(r, opts.env)), page, pages: Math.ceil(total / limit), total };
}

/** A listed app as the super-admin's gallery moderation list shows it. */
export interface GalleryModerationEntry {
  id: string;
  slug: string;
  name: string | null;
  description: string | null;
  workspaceSlug: string;
  publishedAt: Date | null;
  hiddenAt: Date | null;
  /** Shown on the public list right now. */
  visible: boolean;
  /** The production host serves a version. */
  published: boolean;
}

/**
 * Every live app whose owner listed it (visible or not) plus every hidden
 * one, newest publish first — the `/admin/abuse` gallery section.
 */
export async function listGalleryForModeration(opts: { limit?: number } = {}): Promise<GalleryModerationEntry[]> {
  const rows = await getDb()
    .select({
      id: apps.id,
      slug: apps.slug,
      name: apps.name,
      description: apps.galleryDescription,
      workspaceSlug: workspaces.slug,
      publishedAt: apps.publishedAt,
      hiddenAt: apps.galleryHiddenAt,
      visible: sql<boolean>`(${and(...visibleInGallery())})`,
      published: sql<boolean>`(${apps.publishedVersionId} IS NOT NULL)`,
    })
    .from(apps)
    .innerJoin(workspaces, eq(workspaces.id, apps.workspaceId))
    .where(and(isNull(apps.deletedAt), sql`(${apps.galleryListed} OR ${apps.galleryHiddenAt} IS NOT NULL)`))
    .orderBy(sql`${apps.publishedAt} DESC NULLS LAST`, desc(apps.slug))
    .limit(Math.min(Math.max(opts.limit ?? 200, 1), 500));
  return rows.map((r) => ({ ...r, visible: Boolean(r.visible), published: Boolean(r.published) }));
}
