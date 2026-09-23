/**
 * wsSlug → workspace id, Redis read-through (`drobek:serve:ws:<wsSlug>`).
 * Workspace slugs never change, so positive results are cached for 5 minutes.
 */
import { eq } from 'drizzle-orm';
import { getRedis } from '@drobek/core';
import { getDb, workspaces } from '@drobek/db';

const WS_TTL_SEC = 300;

function wsKey(wsSlug: string): string {
  return `drobek:serve:ws:${wsSlug}`;
}

export async function resolveWorkspaceId(wsSlug: string): Promise<string | null> {
  if (!wsSlug) return null;
  const redis = getRedis();
  const cached = await redis.get(wsKey(wsSlug));
  if (cached) return cached;

  const rows = await getDb()
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.slug, wsSlug))
    .limit(1);
  const id = rows[0]?.id ?? null;
  if (id) await redis.set(wsKey(wsSlug), id, 'EX', WS_TTL_SEC);
  return id;
}
