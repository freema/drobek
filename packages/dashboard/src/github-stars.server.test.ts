import { describe, expect, it, vi } from 'vitest';
import {
  STARS_RETRY_MS,
  STARS_TIMEOUT_MS,
  STARS_TTL_MS,
  createStarsCache,
  githubRepoOf,
  starsEnabled,
} from './github-stars.server.js';

type Init = { headers: Record<string, string>; signal: AbortSignal };

function ok(count: unknown) {
  return { ok: true, json: async () => ({ stargazers_count: count }) };
}

describe('githubRepoOf / starsEnabled', () => {
  it('reads owner/repo from a github.com URL only', () => {
    expect(githubRepoOf('https://github.com/freema/drobek')).toBe('freema/drobek');
    expect(githubRepoOf('https://github.com/some-fork/drobek.git')).toBe('some-fork/drobek');
    expect(githubRepoOf('https://gitlab.com/freema/drobek')).toBeNull();
    expect(githubRepoOf('https://github.com/freema')).toBeNull();
  });

  it('is on by default and off for off/false/0/no', () => {
    expect(starsEnabled({})).toBe(true);
    expect(starsEnabled({ DASHBOARD_GITHUB_STARS: 'on' })).toBe(true);
    for (const v of ['off', 'false', '0', 'no', ' OFF ']) expect(starsEnabled({ DASHBOARD_GITHUB_STARS: v })).toBe(false);
  });
});

describe('createStarsCache (NSO-342 footer stars)', () => {
  it('never waits: the first peek is null, the count arrives in the background', async () => {
    const fetch = vi.fn(async (_url: string, _init: Init) => ok(42));
    const cache = createStarsCache({ repo: 'freema/drobek', fetch });
    expect(cache.peek()).toBeNull();
    await cache.pending();
    expect(cache.peek()).toBe(42);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/freema/drobek');
    // Unauthenticated: no Authorization header, a User-Agent (GitHub requires one) and a timeout signal.
    expect(init.headers).toEqual({ Accept: 'application/vnd.github+json', 'User-Agent': 'drobek' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('caches for an hour, then refreshes once (concurrent peeks share one request)', async () => {
    let now = 0;
    let count = 7;
    const fetch = vi.fn(async () => ok(count));
    const cache = createStarsCache({ repo: 'freema/drobek', fetch, now: () => now });
    cache.peek();
    cache.peek();
    await cache.pending();
    expect(fetch).toHaveBeenCalledTimes(1);

    now = STARS_TTL_MS - 1;
    count = 8;
    expect(cache.peek()).toBe(7);
    expect(cache.pending()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);

    now = STARS_TTL_MS;
    expect(cache.peek()).toBe(7);
    await cache.pending();
    expect(cache.peek()).toBe(8);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a failure, an error answer or a bad body keeps the last count and retries later', async () => {
    let now = 0;
    const answers: (() => Promise<{ ok: boolean; json(): Promise<unknown> }>)[] = [
      async () => ok(5),
      async () => {
        throw new Error('ECONNRESET');
      },
      async () => ({ ok: false, json: async () => ({ message: 'API rate limit exceeded' }) }),
      async () => ok('many'),
      async () => ok(6),
    ];
    const fetch = vi.fn(async () => (answers.shift() as () => Promise<{ ok: boolean; json(): Promise<unknown> }>)());
    const cache = createStarsCache({ repo: 'freema/drobek', fetch, now: () => now });
    cache.peek();
    await cache.pending();
    expect(cache.peek()).toBe(5);

    for (let i = 0; i < 3; i++) {
      now += i === 0 ? STARS_TTL_MS : STARS_RETRY_MS;
      cache.peek();
      await cache.pending();
      expect(cache.peek()).toBe(5);
      // Within the retry window nothing is fetched again.
      now += STARS_RETRY_MS - 1;
      cache.peek();
      expect(cache.pending()).toBeNull();
      now -= STARS_RETRY_MS - 1;
    }
    now += STARS_RETRY_MS;
    cache.peek();
    await cache.pending();
    expect(cache.peek()).toBe(6);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('a hanging GitHub is cut off by the timeout and the page value stays null', async () => {
    const fetch = vi.fn(
      (_url: string, init: Init) =>
        new Promise<never>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        })
    );
    const cache = createStarsCache({ repo: 'freema/drobek', fetch, timeoutMs: 20 });
    const started = Date.now();
    expect(cache.peek()).toBeNull();
    expect(Date.now() - started).toBeLessThan(20);
    await cache.pending();
    expect(cache.peek()).toBeNull();
    expect(STARS_TIMEOUT_MS).toBe(3000);
  });

  it('disabled (or no GitHub repo) → never fetches', () => {
    const fetch = vi.fn(async () => ok(1));
    expect(createStarsCache({ repo: 'freema/drobek', enabled: false, fetch }).peek()).toBeNull();
    expect(createStarsCache({ repo: null, fetch }).peek()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
