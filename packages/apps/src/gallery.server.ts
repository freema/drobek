/**
 * The public gallery, the stateful half (NSO-340):
 *
 *  - `setGalleryListing` — an editor+ lists a PUBLISHED app with a short
 *    public description, changes the description, or unlists it. The same
 *    function serves the dashboard (the app's Overview) and the MCP tool
 *    `set_gallery_listing` (which additionally demands the user's explicit
 *    yes). Audited `app.gallery_listed` / `app.gallery_unlisted`.
 *  - `setGalleryHidden` — a super-admin hides an entry (or shows it again);
 *    a hidden app cannot be listed by anyone. Audited `app.gallery_hidden` /
 *    `app.gallery_unhidden`.
 *  - `listGallery` — the public list behind `GET /api/public/gallery`: name,
 *    description, production URL, publish time — never an owner, workspace or
 *    id. It filters at QUERY time (listed AND published AND public AND not
 *    taken down AND not deleted AND not hidden), so an unpublish, a takedown
 *    or a delete takes the entry off the list with the very next request,
 *    whatever the flag says. unpublishApp / takedownApp also clear the flag
 *    (the owner lists again after publishing again).
 *
 * GALLERY_ENABLED (default off) gates every change here; the public endpoint
 * checks it itself.
 */
import { and, desc, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { AUDIT_ACTIONS, writeAudit } from '@drobek/audit';
import { apps, getDb, workspaces } from '@drobek/db';
import { AppsError } from './errors.js';
import {
  GALLERY_PAGE_SIZE,
  decodeGalleryCursor,
  encodeGalleryCursor,
  galleryEnabled,
  normalizeGalleryDescription,
} from './gallery.js';
import { lockedByAdminError } from './moderation.server.js';
import { publishedUrl } from './origin.js';
import type { Actor } from './types.js';

function refuseWhenDisabled(env: NodeJS.ProcessEnv): void {
  if (!galleryEnabled(env)) {
    throw new AppsError('gallery_disabled', 'The public gallery is turned off on this server.');
  }
}

export type GalleryListingInput = { listed: true; description: string } | { listed: false };

export interface GalleryListingResult {
  /** false = the app already was in that state (nothing written, no audit). */
  changed: boolean;
  listed: boolean;
  description: string | null;
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
  return getDb().transaction(async (tx) => {
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
      })
      .from(apps)
      .where(and(eq(apps.id, appId), isNull(apps.deletedAt)))
      .for('update');
    if (!app) throw new AppsError('not_found', `App ${appId} does not exist.`);
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
      if (!app.galleryListed) return { changed: false, listed: false, description: app.galleryDescription, slug: app.slug };
      await tx.update(apps).set({ galleryListed: false }).where(eq(apps.id, app.id));
      await audit(AUDIT_ACTIONS.appGalleryUnlisted, { reason: 'owner' });
      return { changed: true, listed: false, description: app.galleryDescription, slug: app.slug };
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
    if (app.galleryListed && app.galleryDescription === description) {
      return { changed: false, listed: true, description, slug: app.slug };
    }
    await tx.update(apps).set({ galleryListed: true, galleryDescription: description }).where(eq(apps.id, app.id));
    await audit(AUDIT_ACTIONS.appGalleryListed, {
      description,
      ...(app.galleryListed ? { previousDescription: app.galleryDescription } : {}),
    });
    return { changed: true, listed: true, description, slug: app.slug };
  });
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
  opts: { now?: Date } = {}
): Promise<{ changed: boolean; slug: string }> {
  return getDb().transaction(async (tx) => {
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
        actorKind: 'user',
        action: hidden ? AUDIT_ACTIONS.appGalleryHidden : AUDIT_ACTIONS.appGalleryUnhidden,
        subjectType: 'app',
        target: app.slug,
        meta: {},
      },
      tx
    );
    return { changed: true, slug: app.slug };
  });
}

/** One public gallery entry — exactly what `GET /api/public/gallery` returns per app. */
export interface GalleryItem {
  name: string;
  description: string;
  /** The production URL `https://<slug>.<APPS_DOMAIN>`. */
  url: string;
  /** ISO 8601, when the production host last started serving a version. */
  publishedAt: string;
}

/** Listed AND published AND public AND not taken down AND not deleted AND not hidden. */
function visibleInGallery(): SQL[] {
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

/**
 * One page of the public gallery, newest publish first (ties by slug), and
 * the `next` cursor when more entries follow. A cursor that does not decode
 * starts at the first page.
 */
export async function listGallery(
  opts: { limit?: number; cursor?: string | null; env?: NodeJS.ProcessEnv } = {}
): Promise<{ items: GalleryItem[]; next: string | null }> {
  const limit = opts.limit ?? GALLERY_PAGE_SIZE;
  const cursor = decodeGalleryCursor(opts.cursor);
  const where = visibleInGallery();
  if (cursor) {
    where.push(sql`(${apps.publishedAt}, ${apps.slug}) < (${cursor.publishedAt.toISOString()}::timestamp, ${cursor.slug})`);
  }
  const rows = await getDb()
    .select({ slug: apps.slug, name: apps.name, description: apps.galleryDescription, publishedAt: apps.publishedAt })
    .from(apps)
    .where(and(...where))
    .orderBy(desc(apps.publishedAt), desc(apps.slug))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      name: r.name ?? r.slug,
      description: r.description ?? '',
      url: publishedUrl(r.slug, opts.env),
      publishedAt: (r.publishedAt as Date).toISOString(),
    })),
    next: rows.length > limit && last ? encodeGalleryCursor({ publishedAt: last.publishedAt as Date, slug: last.slug }) : null,
  };
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
    })
    .from(apps)
    .innerJoin(workspaces, eq(workspaces.id, apps.workspaceId))
    .where(and(isNull(apps.deletedAt), sql`(${apps.galleryListed} OR ${apps.galleryHiddenAt} IS NOT NULL)`))
    .orderBy(sql`${apps.publishedAt} DESC NULLS LAST`, desc(apps.slug))
    .limit(Math.min(Math.max(opts.limit ?? 200, 1), 500));
  return rows.map((r) => ({ ...r, visible: Boolean(r.visible) }));
}
