import { eq } from 'drizzle-orm';
import { AUDIT_ACTIONS, writeAudit } from '@drobek/audit';
import { apps, getDb } from '@drobek/db';
import { AppsError } from './errors.js';
import { suggestSlug, validateAppSlug } from './slug.js';
import type { Actor } from './types.js';

export interface CreateAppInput {
  workspaceId: string;
  slug: string;
  actor: Actor;
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
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
 * `slug_taken` + a free `<slug>-<4hex>` suggestion. Audited as `app.create`.
 */
export async function createApp(input: CreateAppInput): Promise<{ id: string; slug: string }> {
  const { workspaceId, slug, actor } = input;
  const reason = validateAppSlug(slug);
  if (reason) {
    const suggestion = suggestSlug(slug);
    throw new AppsError('invalid_slug', `The slug "${slug}" ${reason}.`, {
      suggestion: validateAppSlug(suggestion) ? undefined : suggestion,
    });
  }
  if (await slugExists(slug)) throw await slugTaken(slug);

  try {
    return await getDb().transaction(async (tx) => {
      const [row] = await tx
        .insert(apps)
        .values({ workspaceId, slug })
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
}
