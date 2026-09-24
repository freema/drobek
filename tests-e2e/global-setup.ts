import { Redis } from 'ioredis';
import pg from 'pg';
import { BASE_URL_WEB } from './playwright.config';

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
  'version_files',
  'app_versions',
  'blobs',
  'apps',
  // M0-04: DCR clients never authorized count toward the unused-client cap
  // (OAUTH_DCR_MAX_UNUSED_CLIENTS) — start every run from zero.
  'oauth_clients',
  'memberships',
  'workspaces',
  'users',
];

/**
 * U2: deterministic reruns for the auth specs — drop leftover OTP + rate-limit
 * counters (per-IP windows accumulate across runs). Mirrors the destructive
 * DB guard: ONLY `drobek:otp|rl|applock|mail:*` keys (M1-04: the mail pause), ONLY when TEST_ENV=local
 * AND the REDIS_URL host is local. Never touches `drobek:session:*`.
 */
const ALLOWED_REDIS_HOSTS = ['localhost', '127.0.0.1', 'redis'];
const REDIS_CLEANUP_PATTERNS = ['drobek:otp:*', 'drobek:rl:*', 'drobek:applock:*', 'drobek:mail:*'];

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

/**
 * NSO-314 belt-and-braces: settle a Vite dev target before the first browser
 * test. The dev server's client dep optimizer used to discover server-only
 * deps lazily on the first SSR renders after a cold cache (lockfile change,
 * `compose up -V`) and force a full page reload that wiped the first sign-in
 * of the run. apps/server's vite.config now pins the optimizer
 * (`noDiscovery`), so this normally returns after one round: render a few
 * pages, then wait until the pre-bundle hash the client modules import
 * (`.vite/deps/*?v=<hash>`) is stable. Production targets (no `/@vite/client`)
 * are skipped.
 */
const WARMUP_PAGES = ['/healthz', '/', '/login', '/login/verify?email=warmup%40example.com', '/build-with-your-agent'];

async function viteDepsHash(base: string): Promise<string> {
  const res = await fetch(`${base}/app/root.tsx`).catch(() => null);
  if (!res?.ok) return '';
  return /\.vite\/deps\/[^"']*\?v=([0-9a-f]+)/.exec(await res.text())?.[1] ?? '';
}

async function warmUpViteDevServer(base: string): Promise<void> {
  const probe = await fetch(`${base}/@vite/client`).catch(() => null);
  await probe?.body?.cancel();
  if (!probe?.ok) return;
  const deadline = Date.now() + 30_000;
  let previous = '';
  for (;;) {
    for (const path of WARMUP_PAGES) {
      await fetch(`${base}${path}`, { redirect: 'manual' })
        .then((r) => r.arrayBuffer())
        .catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, 1_500));
    const hash = await viteDepsHash(base);
    if (hash !== '' && hash === previous) return;
    if (Date.now() > deadline) {
      console.warn('tests-e2e: the Vite dev optimizer did not settle within 30 s — continuing.');
      return;
    }
    previous = hash;
  }
}

export default async function globalSetup(): Promise<void> {
  await cleanupAuthRedisKeys();
  await warmUpViteDevServer(BASE_URL_WEB);

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
