/**
 * The GitHub star count in the dashboard footer (NSO-342). Server-only.
 *
 * `GET https://api.github.com/repos/<owner>/<repo>` → `stargazers_count`,
 * unauthenticated, with a 3 s timeout. The value is kept in memory for an
 * hour (a failure is retried after 10 minutes, keeping the last known count).
 * `peek()` NEVER waits: it answers from memory at once and, when the value is
 * stale, starts one background refresh — so a slow or failing GitHub never
 * slows or breaks a page; the footer simply omits the stars until a count is
 * known. `DASHBOARD_GITHUB_STARS=off` disables the outbound call entirely
 * (e.g. an air-gapped self-host).
 */
import { SOURCE_REPO_URL } from './source-link.js';

export const STARS_TTL_MS = 60 * 60 * 1000;
export const STARS_RETRY_MS = 10 * 60 * 1000;
export const STARS_TIMEOUT_MS = 3000;

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

interface StarsCacheOptions {
  /** `owner/repo` on github.com; null disables the lookup. */
  repo: string | null;
  enabled?: boolean;
  fetch?: FetchLike;
  now?: () => number;
  ttlMs?: number;
  retryMs?: number;
  timeoutMs?: number;
}

interface StarsCache {
  /** The last known count (null until one is known); refreshes in the background when stale. */
  peek(): number | null;
  /** The refresh in flight, if any (tests await it). */
  pending(): Promise<void> | null;
}

/** `https://github.com/<owner>/<repo>` → `owner/repo`; anything else → null. */
export function githubRepoOf(url: string): string | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** `DASHBOARD_GITHUB_STARS`: on unless `off` / `false` / `0` / `no`. */
export function starsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.DASHBOARD_GITHUB_STARS ?? '').trim().toLowerCase();
  return !['off', 'false', '0', 'no'].includes(v);
}

export function createStarsCache(opts: StarsCacheOptions): StarsCache {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? STARS_TTL_MS;
  const retry = opts.retryMs ?? STARS_RETRY_MS;
  const timeoutMs = opts.timeoutMs ?? STARS_TIMEOUT_MS;
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const active = (opts.enabled ?? true) && opts.repo !== null;

  let value: number | null = null;
  let nextAt = 0;
  let inflight: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    try {
      const res = await doFetch(`https://api.github.com/repos/${opts.repo}`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'drobek' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = res.ok ? ((await res.json()) as { stargazers_count?: unknown }) : null;
      const count = body?.stargazers_count;
      if (typeof count === 'number' && Number.isInteger(count) && count >= 0) {
        value = count;
        nextAt = now() + ttl;
        return;
      }
      nextAt = now() + retry;
    } catch {
      // Timeout, DNS, rate limit, bad JSON: keep the last count, try again later.
      nextAt = now() + retry;
    }
  }

  return {
    peek() {
      if (active && !inflight && now() >= nextAt) {
        inflight = refresh().finally(() => {
          inflight = null;
        });
      }
      return value;
    },
    pending: () => inflight,
  };
}

let shared: StarsCache | null = null;

/** The footer's star count of the source repository (null = omit the stars). */
export function githubStars(): number | null {
  shared ??= createStarsCache({ repo: githubRepoOf(SOURCE_REPO_URL), enabled: starsEnabled() });
  return shared.peek();
}
