/**
 * The app's single-writer lease (M0-05) as the rest of the platform sees it:
 * the Redis key `drobek:applock:<app_id>` holding
 * `{ holder_user_id, session_id, expires_at, renewed_at? }` with a TTL.
 * @drobek/mcp acquires / renews it (its Lua script lives there); this module
 * owns the key format + value parsing so the dashboard can READ the lease
 * ("an agent of X is working on this app") and RELEASE it (NSO-288,
 * "unlock") without depending on the MCP package.
 */
import { AUDIT_ACTIONS, writeAudit } from '@drobek/audit';
import { getRedis } from '@drobek/core';
import type { Actor } from './types.js';

export const LEASE_KEY_PREFIX = 'drobek:applock:';

export function leaseKey(appId: string): string {
  return `${LEASE_KEY_PREFIX}${appId}`;
}

export interface Lease {
  holder_user_id: string;
  session_id: string;
  /** ISO timestamp — informational; the key's TTL is what actually expires it. */
  expires_at: string;
  /** ISO timestamp of the last acquire/renew (older leases lack it). */
  renewed_at?: string;
}

/** A stored lease value, or null for anything that is not one. */
export function parseLease(raw: string | null | undefined): Lease | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Lease>;
    if (typeof v.holder_user_id !== 'string' || typeof v.expires_at !== 'string') return null;
    const lease: Lease = {
      holder_user_id: v.holder_user_id,
      session_id: String(v.session_id ?? ''),
      expires_at: v.expires_at,
    };
    if (typeof v.renewed_at === 'string') lease.renewed_at = v.renewed_at;
    return lease;
  } catch {
    return null;
  }
}

/** The Redis commands the lease helpers need (tests pass a fake). */
export type LeaseRedis = Pick<ReturnType<typeof getRedis>, 'get' | 'eval'>;

/** The app's live lease, or null when it is free. */
export async function readAppLease(appId: string, redis: LeaseRedis = getRedis()): Promise<Lease | null> {
  return parseLease(await redis.get(leaseKey(appId)));
}

/** GET + DEL in one step: returns the value that was removed (nil when free). */
const TAKE_LUA = `
local cur = redis.call('GET', KEYS[1])
if cur then redis.call('DEL', KEYS[1]) end
return cur
`;

/**
 * Remove the app's lease ("unlock" in the dashboard): the next write of ANY
 * member's agent takes it fresh. Atomic (the removed value is exactly the
 * one reported), audited `app.lock.release` with the previous holder. A free
 * app is a no-op (`released: false`, nothing audited).
 */
export async function releaseAppLease(
  app: { id: string; slug: string; workspaceId: string },
  actor: Actor,
  redis: LeaseRedis = getRedis()
): Promise<{ released: boolean; previous: Lease | null }> {
  const raw = (await redis.eval(TAKE_LUA, 1, leaseKey(app.id))) as string | null;
  if (!raw) return { released: false, previous: null };
  const previous = parseLease(raw);
  await writeAudit({
    workspaceId: app.workspaceId,
    actorUserId: actor.userId,
    actorKind: actor.kind,
    action: AUDIT_ACTIONS.appLockRelease,
    subjectType: 'app',
    target: app.slug,
    meta: {
      previousHolderUserId: previous?.holder_user_id ?? null,
      expiresAt: previous?.expires_at ?? null,
    },
  });
  return { released: true, previous };
}
