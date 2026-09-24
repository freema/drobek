/**
 * The single-writer lease (M0-05): Redis key `drobek:applock:<app_id>` =
 * `{ holder_user_id, session_id, expires_at }` with a TTL (3 min), renewed by
 * every write_files / restore_version. Another USER gets `app_locked`; the
 * same user from another session takes the lease over (it is their app).
 *
 * Acquire/renew/take-over is ONE Lua script, so two agents racing for a free
 * app can never both win: the script reads the holder and writes the new
 * value atomically inside Redis.
 */
import { LEASE_KEY_PREFIX, leaseKey, parseLease, type Lease } from '@drobek/apps';
import type { getRedis } from '@drobek/core';

// The key format + value shape live in @drobek/apps (the dashboard reads and
// releases the lease too, NSO-288); re-exported for the existing importers.
export { LEASE_KEY_PREFIX, leaseKey, type Lease };

interface LeaseHolder {
  userId: string;
  sessionId: string;
}

type AcquireResult = { acquired: true; lease: Lease } | { acquired: false; lease: Lease };

export interface LeaseStore {
  /** Take (free / expired / own) or renew the lease; report the holder otherwise. */
  acquire(appId: string, holder: LeaseHolder, ttlMs: number): Promise<AcquireResult>;
  /** The live leases of these apps (missing = free). */
  get(appIds: string[]): Promise<Map<string, Lease>>;
}

/**
 * KEYS[1] lease key · ARGV[1] caller user id · ARGV[2] new lease JSON · ARGV[3] TTL ms.
 * Returns {1, new} when the caller now holds it, {0, current} when another
 * user does. An unreadable value is treated as free (overwritten).
 */
const ACQUIRE_LUA = `
local cur = redis.call('GET', KEYS[1])
if cur then
  local ok, lease = pcall(cjson.decode, cur)
  if ok and type(lease) == 'table' and lease.holder_user_id ~= nil and lease.holder_user_id ~= ARGV[1] then
    return {0, cur}
  end
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', tonumber(ARGV[3]))
return {1, ARGV[2]}
`;

type RedisLike = Pick<ReturnType<typeof getRedis>, 'eval' | 'mget'>;

export function redisLeaseStore(redis: () => RedisLike, now: () => number = Date.now): LeaseStore {
  return {
    async acquire(appId, holder, ttlMs) {
      const lease: Lease = {
        holder_user_id: holder.userId,
        session_id: holder.sessionId,
        expires_at: new Date(now() + ttlMs).toISOString(),
        renewed_at: new Date(now()).toISOString(),
      };
      const [won, raw] = (await redis().eval(
        ACQUIRE_LUA,
        1,
        leaseKey(appId),
        holder.userId,
        JSON.stringify(lease),
        String(ttlMs)
      )) as [number, string];
      const current = parseLease(raw) ?? lease;
      return won === 1 ? { acquired: true, lease: current } : { acquired: false, lease: current };
    },
    async get(appIds) {
      const out = new Map<string, Lease>();
      if (appIds.length === 0) return out;
      const values = await redis().mget(...appIds.map(leaseKey));
      appIds.forEach((id, i) => {
        const lease = parseLease(values[i] ?? null);
        if (lease) out.set(id, lease);
      });
      return out;
    },
  };
}

/**
 * In-process lease store with the SAME semantics (tests, clock seam): expiry
 * is decided by `now()`, so a test can jump past the TTL without sleeping.
 */
export function memoryLeaseStore(now: () => number = Date.now): LeaseStore & { clear(): void } {
  const leases = new Map<string, { lease: Lease; expiresAtMs: number }>();
  const live = (appId: string) => {
    const e = leases.get(appId);
    if (e && e.expiresAtMs <= now()) {
      leases.delete(appId);
      return null;
    }
    return e ?? null;
  };
  return {
    async acquire(appId, holder, ttlMs) {
      const cur = live(appId);
      if (cur && cur.lease.holder_user_id !== holder.userId) return { acquired: false, lease: cur.lease };
      const expiresAtMs = now() + ttlMs;
      const lease: Lease = {
        holder_user_id: holder.userId,
        session_id: holder.sessionId,
        expires_at: new Date(expiresAtMs).toISOString(),
        renewed_at: new Date(now()).toISOString(),
      };
      leases.set(appId, { lease, expiresAtMs });
      return { acquired: true, lease };
    },
    async get(appIds) {
      const out = new Map<string, Lease>();
      for (const id of appIds) {
        const e = live(id);
        if (e) out.set(id, e.lease);
      }
      return out;
    },
    clear() {
      leases.clear();
    },
  };
}
