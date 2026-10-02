/**
 * Duplicating a gallery app: a signed-in person copies an app its
 * owner listed in the public gallery with "allow duplicates" on into a
 * workspace where they are an editor+. This is the files half, shared by the
 * dashboard's `/duplicate/:slug` page and the MCP tool `duplicate_app`; the
 * module configs are copied by @drobek/modules (`duplicateModuleConfigs`),
 * through the normal confirmation flow of the new app.
 *
 * The copy is the PUBLISHED version's files (sources and build output) as
 * version 1 of a new, unpublished app that remembers its source. Nothing
 * else of the source is copied: no preview drafts, uploaded assets, data,
 * end users, secrets, domains or gallery listing. Audited `app.duplicate` on
 * the new app and `app.duplicated` on the source (without the copier).
 * DUPLICATES_PER_USER_HOUR (default 10) caps copies per person per hour
 * across workspaces and surfaces: the `app.duplicate` row is counted and
 * written inside the new app's create transaction under a per-person advisory
 * lock, so parallel requests cannot all pass. A copy counts once its app row
 * exists (also when writing its files then fails, since the app stays); a
 * copy refused before that (source gone, workspace full) does not count.
 * The copy's version 1 counts against the person's VERSIONS_PER_USER_HOUR
 * and the target workspace's WORKSPACE_SOURCE_QUOTA, both checked before the
 * app is created as well (version-rate.server.ts, version-retention.server.ts).
 */
import { and, count, eq, gt, isNull, sql } from 'drizzle-orm';
import { AUDIT_ACTIONS, writeAudit, type AuditExecutor } from '@drobek/audit';
import { apps, auditLog, getDb, moduleConfigs, workspaces } from '@drobek/db';
import { createApp } from './apps.server.js';
import { AppsError } from './errors.js';
import { notifyAppChanged } from './events.js';
import { galleryEnabled, isGalleryVisible } from './gallery.js';
import { deriveSlug, suggestSlug, validateAppSlug } from './slug.js';
import type { Actor } from './types.js';
import { createVersion, getVersion, readBlobs } from './versions.server.js';
import { assertVersionRate, versionRateLimits, type VersionRateLimits } from './version-rate.server.js';
import { assertSourceQuota, versionStorageLimits } from './version-retention.server.js';

export const DEFAULT_DUPLICATES_PER_USER_HOUR = 10;
const HOUR_MS = 3_600_000;
/** A copy's name: the same bound as create_app's `name`. */
export const DUPLICATE_NAME_MAX = 80;

/** DUPLICATES_PER_USER_HOUR, else DEFAULT_DUPLICATES_PER_USER_HOUR. */
export function duplicatesPerUserHour(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.DUPLICATES_PER_USER_HOUR?.trim());
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DUPLICATES_PER_USER_HOUR;
}

/** A gallery app that may be duplicated, as the confirm page and duplicate_app show it. */
export interface DuplicationSource {
  id: string;
  slug: string;
  name: string;
  description: string;
  /** The author's workspace name (its slug when unnamed). */
  workspaceName: string;
  workspaceSlug: string;
  workspaceId: string;
  publishedVersionId: string;
  /** Module names with a saved configuration. */
  modules: string[];
}

/**
 * The gallery app `slug` when it can be duplicated right now: the gallery is
 * on, the app is shown in it (listed, published, public, not taken down,
 * hidden or deleted) and its owner allows duplicates. Otherwise
 * `gallery_disabled`, `not_found` (not in the gallery — the same answer as an
 * unknown slug, so apps outside the gallery are not revealed) or
 * `not_duplicable`.
 */
export async function duplicationSource(slug: string, env: NodeJS.ProcessEnv = process.env): Promise<DuplicationSource> {
  if (!galleryEnabled(env)) throw new AppsError('gallery_disabled', 'The public gallery is turned off on this server.');
  const wanted = String(slug ?? '').trim().toLowerCase();
  const [row] = await getDb()
    .select({
      id: apps.id,
      slug: apps.slug,
      name: apps.name,
      workspaceId: apps.workspaceId,
      workspaceName: workspaces.name,
      workspaceSlug: workspaces.slug,
      galleryListed: apps.galleryListed,
      galleryDescription: apps.galleryDescription,
      galleryHiddenAt: apps.galleryHiddenAt,
      galleryAllowDuplicate: apps.galleryAllowDuplicate,
      publishedVersionId: apps.publishedVersionId,
      publishedAt: apps.publishedAt,
      lockedReason: apps.lockedReason,
      visibility: apps.visibility,
      deletedAt: apps.deletedAt,
    })
    .from(apps)
    .innerJoin(workspaces, eq(workspaces.id, apps.workspaceId))
    .where(and(eq(apps.slug, wanted), isNull(apps.deletedAt)))
    .limit(1);
  if (!row || !isGalleryVisible(row) || !row.publishedVersionId) {
    throw new AppsError('not_found', `No app "${wanted}" is in the public gallery.`);
  }
  if (!row.galleryAllowDuplicate) {
    throw new AppsError('not_duplicable', `The owner of "${row.name ?? row.slug}" does not allow duplicating it.`);
  }
  const configs = await getDb()
    .select({ module: moduleConfigs.module, config: moduleConfigs.config })
    .from(moduleConfigs)
    .where(eq(moduleConfigs.appId, row.id))
    .orderBy(moduleConfigs.module);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name ?? row.slug,
    description: row.galleryDescription ?? '',
    workspaceName: row.workspaceName?.trim() || row.workspaceSlug,
    workspaceSlug: row.workspaceSlug,
    workspaceId: row.workspaceId,
    publishedVersionId: row.publishedVersionId,
    modules: configs
      .filter((c) => c.config !== null && typeof c.config === 'object' && Object.keys(c.config as object).length > 0)
      .map((c) => c.module),
  };
}

/** The default name of a copy: "<name> copy", within DUPLICATE_NAME_MAX characters. */
export function defaultCopyName(name: string): string {
  return `${[...name.trim()].slice(0, DUPLICATE_NAME_MAX - 5).join('')} copy`;
}

/** A copy's name, whitespace collapsed; empty → the default; too long → `invalid_settings`. */
export function copyName(raw: unknown, source: { name: string }): string {
  const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!name) return defaultCopyName(source.name);
  if ([...name].length > DUPLICATE_NAME_MAX) {
    throw new AppsError('invalid_settings', `The name can be at most ${DUPLICATE_NAME_MAX} characters.`);
  }
  return name;
}

/** `rate_limited` when `n` copies within the last hour reached DUPLICATES_PER_USER_HOUR. */
function assertUnderRate(n: number, max: number): void {
  if (n >= max) {
    throw new AppsError('rate_limited', `You duplicated ${max} apps in the last hour (DUPLICATES_PER_USER_HOUR). Try again later.`, {
      details: { limit: 'DUPLICATES_PER_USER_HOUR', value: max },
    });
  }
}

/** The person's `app.duplicate` audit rows of the last hour, in every workspace. */
async function recentCopies(db: AuditExecutor, userId: string, now: Date): Promise<number> {
  const [{ n }] = await db
    .select({ n: count() })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actorUserId, userId),
        eq(auditLog.action, AUDIT_ACTIONS.appDuplicate),
        gt(auditLog.createdAt, new Date(now.getTime() - HOUR_MS))
      )
    );
  return Number(n);
}

export interface DuplicateFilesInput {
  source: DuplicationSource;
  workspaceId: string;
  name: string;
  actor: Actor;
  /** The target workspace's APPS_MAX_PER_WORKSPACE (see createApp). */
  maxApps?: number;
  /** The target workspace's VERSIONS_PER_APP_HOUR / VERSIONS_PER_USER_HOUR (see createVersion); default: the env. */
  versionLimits?: VersionRateLimits;
  /** The target workspace's WORKSPACE_SOURCE_QUOTA, bytes (see createVersion); default: the env. */
  sourceQuota?: number;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

/**
 * Create the copy: a new app in `workspaceId` (slug derived from `name`, a
 * free `-xxxx` variant when taken) whose version 1 holds the source's
 * published files. The caller checked the actor's role in the workspace.
 */
export async function duplicateAppFiles(input: DuplicateFilesInput): Promise<{ id: string; slug: string; version: number }> {
  const env = input.env ?? process.env;
  const userId = input.actor.userId;
  if (!userId) throw new AppsError('not_found', 'Sign in to duplicate an app.');
  const now = input.now ?? new Date();
  const max = duplicatesPerUserHour(env);
  assertUnderRate(await recentCopies(getDb(), userId, now), max);
  const versionLimits = input.versionLimits ?? versionRateLimits(env);
  await assertVersionRate({ userId }, versionLimits);
  const version = await getVersion(input.source.id, { id: input.source.publishedVersionId });
  if (!version) throw new AppsError('not_found', `No app "${input.source.slug}" is in the public gallery.`);
  const bytes = await readBlobs(version.files.map((f) => f.sha256));
  const files = version.files.map((f) => {
    const content = bytes.get(f.sha256);
    if (!content) throw new AppsError('not_found', `A file of "${input.source.slug}" is missing.`);
    return { path: f.path, content, kind: f.kind };
  });
  const sourceQuota = input.sourceQuota ?? versionStorageLimits(env).sourceQuota;
  await assertSourceQuota(input.workspaceId, files, sourceQuota);

  const base = deriveSlug(input.name);
  let slug = validateAppSlug(base) ? suggestSlug(base || 'app') : base;
  let created: { id: string; slug: string } | null = null;
  for (let attempt = 0; attempt < 4 && !created; attempt++) {
    try {
      created = await createApp({
        workspaceId: input.workspaceId,
        slug,
        name: input.name,
        actor: input.actor,
        maxApps: input.maxApps,
        duplicatedFrom: { appId: input.source.id, slug: input.source.slug },
        inTransaction: async (tx, app) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`drobek:duplicate:${userId}`}::text))`);
          assertUnderRate(await recentCopies(tx, userId, now), max);
          await writeAudit(
            {
              workspaceId: input.workspaceId,
              actorUserId: userId,
              actorKind: input.actor.kind,
              action: AUDIT_ACTIONS.appDuplicate,
              subjectType: 'app',
              target: app.slug,
              meta: { from: input.source.slug, version: version.number },
            },
            tx
          );
        },
      });
    } catch (err) {
      if (err instanceof AppsError && (err.code === 'slug_taken' || err.code === 'invalid_slug')) {
        slug = err.suggestion ?? suggestSlug(base || 'app');
        continue;
      }
      throw err;
    }
  }
  if (!created) throw new AppsError('slug_taken', `Could not find a free slug for "${input.name}".`);

  const { number } = await createVersion(created.id, files, {
    actor: input.actor,
    reasoning: `Duplicated from ${input.source.slug} (published version ${version.number})`,
    compile: { status: version.compileStatus === 'ok' ? 'ok' : 'error', errors: version.compileErrors },
    versionLimits,
    sourceQuota,
  });
  await notifyAppChanged({ app_id: created.id, slug: created.slug, version: number });
  await writeAudit({
    workspaceId: input.source.workspaceId,
    actorUserId: null,
    actorKind: input.actor.kind,
    action: AUDIT_ACTIONS.appDuplicated,
    subjectType: 'app',
    target: input.source.slug,
    meta: {},
  });
  return { id: created.id, slug: created.slug, version: number };
}
