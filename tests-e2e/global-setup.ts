import { Redis } from 'ioredis';
import pg from 'pg';

/**
 * Guarded-destructive seeding (ROADMAP §4, risk R4).
 *
 * puls truncates unconditionally — the ONE change drobek must make: a stray
 * DATABASE_URL in a shell must never nuke the shared prod `drobek` DB.
 * TRUNCATE runs ONLY when BOTH hold:
 *   1. ALLOW_DESTRUCTIVE=1 is set explicitly, AND
 *   2. the parsed DATABASE_URL hostname is in the local-only allowlist.
 * ALLOW_DESTRUCTIVE=1 against a non-local host is a hard error, not a skip.
 */
const ALLOWED_DB_HOSTS = ['localhost', '127.0.0.1', 'postgres'];

/** Core tables in FK-safe order (children first; CASCADE covers the rest). */
const CORE_TABLES = [
  'deploy_files',
  'blob_refs',
  'blobs',
  'deploys',
  'apps',
  'memberships',
  'workspaces',
  'users',
];

/**
 * U2: deterministic reruns for the auth specs — drop leftover OTP + rate-limit
 * counters (per-IP windows accumulate across runs). Mirrors the destructive
 * DB guard: ONLY `drobek:otp:*` + `drobek:rl:*` keys, ONLY when TEST_ENV=local
 * AND the REDIS_URL host is local. Never touches `drobek:session:*`.
 */
const ALLOWED_REDIS_HOSTS = ['localhost', '127.0.0.1', 'redis'];
const REDIS_CLEANUP_PATTERNS = ['drobek:otp:*', 'drobek:rl:*'];

async function cleanupAuthRedisKeys(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url || process.env.TEST_ENV !== 'local') return;

  const hostname = new URL(url).hostname;
  if (!ALLOWED_REDIS_HOSTS.includes(hostname)) {
    throw new Error(
      `tests-e2e: refusing redis cleanup against host "${hostname}" ` +
        `(allowed: ${ALLOWED_REDIS_HOSTS.join(', ')}). Unset TEST_ENV=local.`
    );
  }

  const redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: true });
  await redis.connect();
  try {
    for (const pattern of REDIS_CLEANUP_PATTERNS) {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          200
        );
        cursor = next;
        if (keys.length > 0) await redis.del(...keys);
      } while (cursor !== '0');
    }
  } finally {
    redis.disconnect();
  }
}

export default async function globalSetup(): Promise<void> {
  await cleanupAuthRedisKeys();

  const url = process.env.DATABASE_URL;
  if (!url) {
    // Pure read-only run (@smoke against any target) — nothing to seed.
    return;
  }

  if (process.env.ALLOW_DESTRUCTIVE !== '1') {
    console.log(
      'tests-e2e: DATABASE_URL set but ALLOW_DESTRUCTIVE!=1 — skipping destructive setup.'
    );
    return;
  }

  const hostname = new URL(url).hostname;
  if (!ALLOWED_DB_HOSTS.includes(hostname)) {
    throw new Error(
      `tests-e2e: refusing destructive setup against DB host "${hostname}" ` +
        `(allowed: ${ALLOWED_DB_HOSTS.join(', ')}). Unset ALLOW_DESTRUCTIVE.`
    );
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      `TRUNCATE TABLE ${CORE_TABLES.join(', ')} RESTART IDENTITY CASCADE;`
    );
  } finally {
    await client.end();
  }
}
