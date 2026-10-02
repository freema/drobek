/**
 * The app's single-writer lease as the rest of the platform sees it:
 * the Redis key `drobek:applock:<app_id>` holding
 * `{ holder_user_id, session_id, expires_at, renewed_at? }` with a TTL.
 * @drobek/mcp acquires / renews it (its Lua script lives there); this module
 * owns the key format + value parsing so the dashboard can READ the lease
 * ("an agent of X is working on this app") and RELEASE it ("unlock") without
 * depending on the MCP package; the MCP `release_lease` releases through it
 * too, and a member who loses write access loses their leases at once
 * (`releaseUserAppLeases`).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { AUDIT_ACTIONS, writeAudit } from '@drobek/audit';
import { getRedis } from '@drobek/core';
import { apps, getDb } from '@drobek/db';
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
 * KEYS[1] lease key · ARGV[1] the user whose lease may go. Returns nil when
 * free, {1, removed} when that user held it, {0, current} when another user
 * does (left in place). An unreadable value holds nobody and is removed.
 */
const TAKE_OWN_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return false end
local ok, lease = pcall(cjson.decode, cur)
if ok and type(lease) == 'table' and lease.holder_user_id ~= nil and lease.holder_user_id ~= ARGV[1] then
  return {0, cur}
end
redis.call('DEL', KEYS[1])
return {1, cur}
`;

/**
 * Remove the app's lease ("unlock" in the dashboard): the next write of ANY
 * member's agent takes it fresh. Atomic (the removed value is exactly the
 * one reported), audited `app.lock.release` with the previous holder. A free
 * app is a no-op (`released: false`, nothing audited). With `holderUserId`
 * (the MCP `release_lease`: an agent frees its own lease) only a lease that
 * user holds goes; another user's stays in place and comes back as
 * `previous` with `released: false`, nothing audited.
 */
export async function releaseAppLease(
  app: { id: string; slug: string; workspaceId: string },
  actor: Actor,
  redis: LeaseRedis = getRedis(),
  opts: { holderUserId?: string } = {}
): Promise<{ released: boolean; previous: Lease | null }> {
  let raw: string | null;
  if (opts.holderUserId === undefined) {
    raw = (await redis.eval(TAKE_LUA, 1, leaseKey(app.id))) as string | null;
  } else {
    const out = (await redis.eval(TAKE_OWN_LUA, 1, leaseKey(app.id), opts.holderUserId)) as [number, string] | null;
    if (out && out[0] === 0) return { released: false, previous: parseLease(out[1]) };
    raw = out ? out[1] : null;
  }
  if (!raw) return { released: false, previous: null };
  const previous = parseLease(raw);
  await auditLeaseRelease(app, actor, previous);
  return { released: true, previous };
}

async function auditLeaseRelease(app: { slug: string; workspaceId: string }, actor: Actor, previous: Lease | null): Promise<void> {
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
}

/** Remove an app's lease only while `holderUserId` holds it; the removed lease, or null. */
export type TakeLeaseHeldBy = (appId: string, holderUserId: string) => Promise<Lease | null>;

/** The Redis TakeLeaseHeldBy (the holder-only take of `releaseAppLease`): atomic, so a lease another user took meanwhile stays. */
export function redisTakeLeaseHeldBy(redis: Pick<ReturnType<typeof getRedis>, 'eval'> = getRedis()): TakeLeaseHeldBy {
  return async (appId, holderUserId) => {
    const out = (await redis.eval(TAKE_OWN_LUA, 1, leaseKey(appId), holderUserId)) as [number, string] | null;
    return out && out[0] === 1 ? parseLease(out[1]) : null;
  };
}

/**
 * Remove every lease `holderUserId` holds on the workspace's apps: the user
 * can no longer write there (removed, left, or now a viewer), and the agents
 * of the remaining editors must not wait for the TTL. Each release is audited
 * `app.lock.release` like the dashboard's unlock, with `actor` as the actor.
 * Returns the slugs of the apps it released.
 */
export async function releaseUserAppLeases(input: {
  workspaceId: string;
  holderUserId: string;
  actor: Actor;
  take?: TakeLeaseHeldBy;
}): Promise<string[]> {
  const take = input.take ?? redisTakeLeaseHeldBy();
  const rows = await getDb()
    .select({ id: apps.id, slug: apps.slug })
    .from(apps)
    .where(and(eq(apps.workspaceId, input.workspaceId), isNull(apps.deletedAt)));
  const released: string[] = [];
  for (const app of rows) {
    const previous = await take(app.id, input.holderUserId);
    if (!previous) continue;
    await auditLeaseRelease({ slug: app.slug, workspaceId: input.workspaceId }, input.actor, previous);
    released.push(app.slug);
  }
  return released;
}
