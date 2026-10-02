/**
 * Team workspaces: any logged-in user may create one (the dashboard's
 * /workspaces form and the MCP tool create_workspace call the same function);
 * the creator becomes workspace-admin. The name is trimmed (1–80 characters),
 * the slug trimmed and lower-cased; slug validation is pure (slug.ts);
 * global uniqueness is the workspaces.slug UNIQUE constraint — a lost race
 * surfaces as { ok: false, reason: 'slug-taken' }, never a 500.
 */
import { getDb, isUniqueViolation, memberships, workspaces } from '@drobek/db';
import { validateTeamSlug } from './slug.js';
import type { WorkspaceSummary } from './membership.server.js';

/** The longest team workspace name. */
const TEAM_NAME_MAX = 80;

export type CreateTeamResult =
  | { ok: true; workspace: WorkspaceSummary }
  | { ok: false; reason: 'invalid-name' | 'invalid-slug' | 'slug-taken'; message: string };

export async function createTeamWorkspace(
  ownerUserId: string,
  rawName: string,
  rawSlug: string
): Promise<CreateTeamResult> {
  const name = rawName.trim();
  const slug = rawSlug.trim().toLowerCase();
  if (!name || name.length > TEAM_NAME_MAX) {
    return { ok: false, reason: 'invalid-name', message: `Enter a team name (1–${TEAM_NAME_MAX} characters).` };
  }
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
