/**
 * App lifecycle + settings beyond versions (M2-01, NSO-288) — what the
 * dashboard changes about an app: unpublish, soft delete (+ the slug release
 * 30 days later), visibility / password and the frame-ancestors override.
 * Every mutation locks the app row, refuses a deleted app (`not_found`) and
 * writes its audit row in the same transaction. Callers announce the change
 * (`notifyAppChanged`) so the app hosts' serve cache drops the app at once.
 *
 * Slug release: a deleted app keeps its slug for SLUG_RELEASE_AFTER_MS
 * (30 days — links and bookmarks keep answering 404 instead of someone
 * else's app), then the slug is renamed to its tombstone
 * `<slug>~deleted-<id>`, which the slug CHECK admits on deleted rows only
 * (migration 0016) and which no host label can ever match (`~`). Two paths
 * run the same `releaseDeletedAppSlugs`: the hourly sweep (Redis lease, next
 * to the blob GC) and createApp for the one slug it wants — so the slug is
 * free exactly 30 days after the delete, not up to an hour later.
 */
import { and, eq, isNotNull, isNull, lte, notLike, type SQL } from 'drizzle-orm';
import { AUDIT_ACTIONS, writeAudit, type AuditExecutor } from '@drobek/audit';
import { appVersions, apps, dbErrorForLog, getDb } from '@drobek/db';
import { AppsError } from './errors.js';
import { withRedisLock } from './lock.server.js';
import type { Actor } from './types.js';

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

export const SLUG_RELEASE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
export const SLUG_RELEASE_INTERVAL_MS = 60 * 60 * 1000;
const TOMBSTONE_MARK = '~deleted-';
const RELEASE_BATCH = 200;
const RELEASE_LOCK_KEY = 'drobek:lock:slug-release';

/** The released-slug tombstone of a deleted app. */
export function tombstoneSlug(slug: string, appId: string): string {
  return `${slug}${TOMBSTONE_MARK}${appId}`;
}

/** When a slug deleted at `deletedAt` becomes free again. */
export function slugReleaseAt(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + SLUG_RELEASE_AFTER_MS);
}

/** Lock a LIVE (not deleted) app row for the rest of the transaction. */
async function lockLiveApp(tx: Tx, appId: string) {
  const [app] = await tx
    .select({
      id: apps.id,
      slug: apps.slug,
      workspaceId: apps.workspaceId,
      publishedVersionId: apps.publishedVersionId,
      visibility: apps.visibility,
      passwordHash: apps.passwordHash,
      frameAncestors: apps.frameAncestors,
    })
    .from(apps)
    .where(and(eq(apps.id, appId), isNull(apps.deletedAt)))
    .for('update');
  if (!app) throw new AppsError('not_found', `App ${appId} does not exist.`);
  return app;
}

async function audit(
  tx: AuditExecutor,
  app: { workspaceId: string; slug: string },
  actor: Actor,
  action: string,
  meta: Record<string, unknown>
): Promise<void> {
  await writeAudit(
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
}

// ── unpublish ────────────────────────────────────────────────────────────────

/**
 * Take the app off its production host: `published_version_id = null` →
 * `<slug>.<APPS_DOMAIN>` answers 404 "not published"; the preview and the
 * version hosts keep serving. Audited `app.unpublish` with the version that
 * was live. `not_published` when nothing is published.
 */
export async function unpublishApp(appId: string, actor: Actor): Promise<{ previousNumber: number }> {
  return getDb().transaction(async (tx) => {
    const app = await lockLiveApp(tx, appId);
    if (!app.publishedVersionId) {
      throw new AppsError('not_published', 'The app is not published.');
    }
    const [prev] = await tx
      .select({ number: appVersions.number })
      .from(appVersions)
      .where(eq(appVersions.id, app.publishedVersionId));
    await tx.update(apps).set({ publishedVersionId: null }).where(eq(apps.id, appId));
    const previousNumber = prev?.number ?? 0;
    await audit(tx, app, actor, AUDIT_ACTIONS.appUnpublish, { previousVersion: previousNumber });
    return { previousNumber };
  });
}

// ── soft delete + slug release ───────────────────────────────────────────────

/**
 * Soft-delete the app: `deleted_at = now` makes it invisible to the
 * dashboard, the MCP tools (`not_found`) and every app host (404). Versions,
 * data and audit rows stay. The slug stays taken until `slugReleaseAt`.
 * Audited `app.delete`.
 */
export async function softDeleteApp(
  appId: string,
  actor: Actor,
  opts: { now?: Date } = {}
): Promise<{ id: string; slug: string; deletedAt: Date; slugReleaseAt: Date }> {
  const now = opts.now ?? new Date();
  return getDb().transaction(async (tx) => {
    const app = await lockLiveApp(tx, appId);
    await tx.update(apps).set({ deletedAt: now }).where(eq(apps.id, appId));
    const releaseAt = slugReleaseAt(now);
    await audit(tx, app, actor, AUDIT_ACTIONS.appDelete, {
      slugReleaseAt: releaseAt.toISOString(),
    });
    return { id: app.id, slug: app.slug, deletedAt: now, slugReleaseAt: releaseAt };
  });
}

export interface ReleasedSlug {
  appId: string;
  workspaceId: string;
  slug: string;
}

/**
 * Release the slugs of apps deleted at least `afterMs` (30 days) before
 * `now`: each is renamed to its tombstone and audited `app.slug_release`
 * (a system action — no acting user). `slug` limits the sweep to that one
 * slug (createApp). Rows another sweep holds are skipped (SKIP LOCKED).
 */
export async function releaseDeletedAppSlugs(
  opts: { now?: Date; afterMs?: number; slug?: string } = {}
): Promise<{ released: ReleasedSlug[] }> {
  const cutoff = new Date((opts.now ?? new Date()).getTime() - (opts.afterMs ?? SLUG_RELEASE_AFTER_MS));
  const conditions: SQL[] = [
    isNotNull(apps.deletedAt),
    lte(apps.deletedAt, cutoff),
    notLike(apps.slug, `%${TOMBSTONE_MARK}%`),
  ];
  if (opts.slug !== undefined) conditions.push(eq(apps.slug, opts.slug));

  const released: ReleasedSlug[] = [];
  for (;;) {
    const batch = await getDb().transaction(async (tx) => {
      const rows = await tx
        .select({ id: apps.id, slug: apps.slug, workspaceId: apps.workspaceId })
        .from(apps)
        .where(and(...conditions))
        .limit(RELEASE_BATCH)
        .for('update', { skipLocked: true });
      for (const r of rows) {
        await tx.update(apps).set({ slug: tombstoneSlug(r.slug, r.id) }).where(eq(apps.id, r.id));
        await writeAudit(
          {
            workspaceId: r.workspaceId,
            actorUserId: null,
            actorKind: 'user',
            action: AUDIT_ACTIONS.appSlugRelease,
            subjectType: 'app',
            target: r.slug,
            meta: { appId: r.id },
          },
          tx
        );
      }
      return rows.map((r) => ({ appId: r.id, workspaceId: r.workspaceId, slug: r.slug }));
    });
    released.push(...batch);
    if (batch.length < RELEASE_BATCH) return { released };
  }
}

/**
 * Hourly slug-release sweep in the server process (next to the blob GC); a
 * Redis lease makes sure only one replica sweeps per hour. Returns a stop
 * function.
 */
export function startSlugRelease(log: (msg: string, error?: string) => void): () => void {
  const run = async () => {
    try {
      const out = await withRedisLock(RELEASE_LOCK_KEY, Math.floor(SLUG_RELEASE_INTERVAL_MS / 1000) - 60, () =>
        releaseDeletedAppSlugs()
      );
      if (out.acquired && out.result.released.length > 0) {
        log(`slug release: released ${out.result.released.length} deleted app slug(s)`);
      }
    } catch (err) {
      log('slug release failed', dbErrorForLog(err));
    }
  };
  const timer = setInterval(() => void run(), SLUG_RELEASE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

// ── settings: visibility + frame-ancestors ──────────────────────────────────

export type VisibilityInput =
  | { visibility: 'public' }
  /** `passwordHash` = a NEW password (hashed by the caller); omit to keep the current one. */
  | { visibility: 'password'; passwordHash?: string | null };

/**
 * Switch the password gate. `public` drops the stored hash (turning the gate
 * back on needs a new password); `password` needs a new hash unless one is
 * already stored. Audited `app.visibility.public` / `app.visibility.password`
 * (never the hash). A change to the state it already has is a no-op.
 */
export async function setAppVisibility(
  appId: string,
  input: VisibilityInput,
  actor: Actor
): Promise<{ changed: boolean; slug: string }> {
  return getDb().transaction(async (tx) => {
    const app = await lockLiveApp(tx, appId);
    if (input.visibility === 'public') {
      if (app.visibility === 'public' && app.passwordHash === null) return { changed: false, slug: app.slug };
      await tx.update(apps).set({ visibility: 'public', passwordHash: null }).where(eq(apps.id, appId));
      await audit(tx, app, actor, AUDIT_ACTIONS.appVisibilityPublic, { previous: app.visibility });
      return { changed: true, slug: app.slug };
    }
    const newHash = input.passwordHash ?? null;
    if (!newHash && !app.passwordHash) {
      throw new AppsError('invalid_settings', 'Set a password to protect the app with one.');
    }
    if (!newHash && app.visibility === 'password') return { changed: false, slug: app.slug };
    await tx
      .update(apps)
      .set({ visibility: 'password', passwordHash: newHash ?? app.passwordHash })
      .where(eq(apps.id, appId));
    await audit(tx, app, actor, AUDIT_ACTIONS.appVisibilityPassword, {
      previous: app.visibility,
      passwordChanged: newHash !== null,
    });
    return { changed: true, slug: app.slug };
  });
}

/**
 * Store the app's CSP frame-ancestors override (null → no embedding). The
 * caller validates it (`parseFrameAncestors` in @drobek/serving) — the header
 * builder re-validates on every response anyway. Audited
 * `app.frame_ancestors.change` with the old and new value.
 */
export async function setFrameAncestors(
  appId: string,
  value: string | null,
  actor: Actor
): Promise<{ changed: boolean; slug: string }> {
  return getDb().transaction(async (tx) => {
    const app = await lockLiveApp(tx, appId);
    if ((app.frameAncestors ?? null) === value) return { changed: false, slug: app.slug };
    await tx.update(apps).set({ frameAncestors: value }).where(eq(apps.id, appId));
    await audit(tx, app, actor, AUDIT_ACTIONS.appFrameAncestors, {
      previous: app.frameAncestors ?? null,
      value,
    });
    return { changed: true, slug: app.slug };
  });
}
