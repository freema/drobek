import { and, count, eq, isNull } from 'drizzle-orm';
import { AUDIT_ACTIONS, writeAudit } from '@drobek/audit';
import { apps, getDb, isUniqueViolation, workspaces } from '@drobek/db';
import { AppsError } from './errors.js';
import { notifyAppChanged } from './events.js';
import { releaseDeletedAppSlugs } from './lifecycle.server.js';
import { suggestSlug, validateAppSlug } from './slug.js';
import type { Actor } from './types.js';

/** Live (not deleted) apps one workspace may hold when neither the env nor the limits provider says otherwise. */
export const DEFAULT_APPS_MAX_PER_WORKSPACE = 50;

export interface CreateAppInput {
  workspaceId: string;
  slug: string;
  /** Human-readable name (create_app's `name`); the slug is derived from it by the caller. */
  name?: string | null;
  actor: Actor;
  /**
   * The workspace's APPS_MAX_PER_WORKSPACE — callers pass the effective value
   * (the limits provider's plan, `ModuleRuntime.workspaceLimits`). Omitted:
   * the env var, else DEFAULT_APPS_MAX_PER_WORKSPACE.
   */
  maxApps?: number;
}

function appsMaxPerWorkspace(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.APPS_MAX_PER_WORKSPACE?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_APPS_MAX_PER_WORKSPACE;
}

async function slugExists(slug: string): Promise<boolean> {
  const rows = await getDb().select({ id: apps.id }).from(apps).where(eq(apps.slug, slug)).limit(1);
  return rows.length > 0;
}

/** A `<slug>-<4hex>` nobody holds right now (best effort — the insert re-checks). */
export async function freeSlugSuggestion(slug: string): Promise<string> {
  let candidate = suggestSlug(slug);
  for (let i = 0; i < 5 && (await slugExists(candidate)); i++) candidate = suggestSlug(slug);
  return candidate;
}

async function slugTaken(slug: string): Promise<AppsError> {
  const suggestion = await freeSlugSuggestion(slug);
  return new AppsError('slug_taken', `The slug "${slug}" is already taken. Try "${suggestion}".`, {
    suggestion,
  });
}

/**
 * Create an app in a workspace. Slugs are global: a taken one fails with
 * `slug_taken` + a free `<slug>-<4hex>` suggestion (a soft-deleted app holds
 * its slug for 30 days). A workspace that already holds `maxApps` live apps
 * fails with `limit_exceeded` (soft-deleted apps do not count; creates in one
 * workspace are serialized on its row). Audited as `app.create`. Announces itself as an
 * app-changed `create` event (NSO-315) so an app host that cached the slug as
 * unknown serves the new app on the very next request.
 */
export async function createApp(input: CreateAppInput): Promise<{ id: string; slug: string }> {
  const { workspaceId, slug, actor } = input;
  const name = input.name?.trim() || null;
  const maxApps = input.maxApps ?? appsMaxPerWorkspace();
  const reason = validateAppSlug(slug);
  if (reason) {
    const suggestion = suggestSlug(slug);
    throw new AppsError('invalid_slug', `The slug "${slug}" ${reason}.`, {
      suggestion: validateAppSlug(suggestion) ? undefined : suggestion,
    });
  }
  // A slug an app deleted 30+ days ago still holds is released right here,
  // not only by the hourly sweep (NSO-288).
  await releaseDeletedAppSlugs({ slug });
  if (await slugExists(slug)) throw await slugTaken(slug);

  let created: { id: string; slug: string };
  try {
    created = await getDb().transaction(async (tx) => {
      // Serialize creates per workspace so two concurrent calls cannot both pass the limit.
      await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for('update');
      const [{ n }] = await tx
        .select({ n: count() })
        .from(apps)
        .where(and(eq(apps.workspaceId, workspaceId), isNull(apps.deletedAt)));
      if (Number(n) >= maxApps) {
        throw new AppsError(
          'limit_exceeded',
          `This workspace already has ${Number(n)} app${Number(n) === 1 ? '' : 's'}; its limit (APPS_MAX_PER_WORKSPACE) is ${maxApps}. Delete an app it no longer needs, or ask for a higher limit.`,
          { details: { limit: 'APPS_MAX_PER_WORKSPACE', value: maxApps } }
        );
      }
      const [row] = await tx
        .insert(apps)
        .values({ workspaceId, slug, name })
        .returning({ id: apps.id, slug: apps.slug });
      await writeAudit(
        {
          workspaceId,
          actorUserId: actor.userId,
          actorKind: actor.kind,
          action: AUDIT_ACTIONS.appCreate,
          subjectType: 'app',
          target: slug,
        },
        tx
      );
      return row;
    });
  } catch (err) {
    // Lost a race for the same slug between the check and the insert.
    if (isUniqueViolation(err)) throw await slugTaken(slug);
    throw err;
  }
  await notifyAppChanged({ app_id: created.id, slug: created.slug, kind: 'create' });
  return created;
}
