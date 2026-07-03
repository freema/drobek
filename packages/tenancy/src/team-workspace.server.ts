/**
 * Team workspaces (U4, PHY-54): any logged-in user may create one; the
 * creator becomes workspace-admin. Slug validation is pure (slug.ts);
 * global uniqueness is the workspaces.slug UNIQUE constraint — a lost race
 * surfaces as { ok: false, reason: 'slug-taken' }, never a 500.
 */
import { getDb, memberships, workspaces } from '@drobek/db';
import { validateTeamSlug } from './slug.js';
import type { WorkspaceSummary } from './membership.server.js';

export type CreateTeamResult =
  | { ok: true; workspace: WorkspaceSummary }
  | { ok: false; reason: 'invalid-slug' | 'slug-taken'; message: string };

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '23505'
  );
}

export async function createTeamWorkspace(
  ownerUserId: string,
  name: string,
  slug: string
): Promise<CreateTeamResult> {
  const slugError = validateTeamSlug(slug);
  if (slugError) {
    return { ok: false, reason: 'invalid-slug', message: slugError };
  }

  try {
    const workspace = await getDb().transaction(async (tx) => {
      const [ws] = await tx
        .insert(workspaces)
        .values({ kind: 'team', slug, name })
        .returning({
          id: workspaces.id,
          slug: workspaces.slug,
          name: workspaces.name,
          kind: workspaces.kind,
        });
      await tx.insert(memberships).values({
        userId: ownerUserId,
        workspaceId: ws.id,
        role: 'workspace-admin',
      });
      return ws;
    });
    return { ok: true, workspace };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        reason: 'slug-taken',
        message: 'That slug is already taken. Pick another one.',
      };
    }
    throw err;
  }
}
