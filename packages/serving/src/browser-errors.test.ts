/**
 * Browser errors of the preview: the beacon's body is checked, capped and
 * redacted; the store dedupes by message + stack with a count, caps the
 * distinct errors per version and sets the TTL; a read maps every frame of a
 * built bundle through its inline source map to the app's source; the
 * handler takes the beacon on the preview and version hosts only, always
 * answers 204 and drops it behind a locked gate, past the per-IP budget, from
 * another origin or for a version with `"browserErrors": false`.
 */
import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppHostTarget } from '@drobek/apps';
import { compile } from '@drobek/compile';
import {
  DEFAULT_BROWSER_ERRORS_MAX_PER_VERSION,
  DEFAULT_BROWSER_ERRORS_PER_IP_MINUTE,
  DEFAULT_BROWSER_ERRORS_TTL_HOURS,
  MAX_ERRORS_PER_BEACON,
  browserErrorLimitsFromEnv,
  parseBrowserErrors,
  type BrowserErrorLimits,
} from './browser-errors.js';
import {
  browserErrorStore,
  bundlesOf,
  mapStack,
  memoryBrowserErrorsRedis,
  takeBrowserErrorBeacon,
  type BrowserErrorStore,
  type VersionBundles,
} from './browser-errors.server.js';
import { handleAppRequest, type AppRequest, type HandlerDeps } from './handler.js';
import type { StoredFile } from './manifest.js';
import { appAccessCookieName, mintAppAccessToken } from './password.js';
import { PREVIEW_ERRORS_PATH } from './preview-script.js';
import { ServeStore, type ServeApp, type ServeLoaders } from './store.server.js';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const LIMITS: BrowserErrorLimits = { perIpMinute: 30, maxPerVersion: 3, ttlHours: 48 };

describe('parseBrowserErrors', () => {
  it('keeps the known fields, caps and redacts them, and drops everything else', () => {
    const b = parseBrowserErrors({
      version: 4,
      ua: 'firefox',
      cookie: 'sid=1',
      errors: [
        {
          type: 'console',
          message: `TypeError for ann@example.com ${'m '.repeat(1000)}`,
          stack: 's '.repeat(4500),
          source: 'https://shop--preview.drobek.app/main.js?v=1#x',
          line: 12,
          col: 5,
          path: '/orders?code=123456#top',
          at: 1,
          count: 3,
          html: '<body>',
        },
      ],
    })!;
    expect(b.version).toBe(4);
    expect(b.ua).toBe('firefox');
    const [e] = b.errors;
    expect(Object.keys(e).sort()).toEqual(['col', 'count', 'key', 'line', 'message', 'path', 'source', 'stack', 'type']);
    expect(e.message).toContain('[redacted-email]');
    expect(e.message).toHaveLength(1024);
    expect(e.stack!.length).toBeLessThanOrEqual(4096);
    expect(e).toMatchObject({ type: 'console', source: 'https://shop--preview.drobek.app/main.js', line: 12, col: 5, path: '/orders', count: 3 });
  });

  it('defaults what is missing or wrong; refuses a body without a usable error', () => {
    const b = parseBrowserErrors({ version: -1, ua: 'netscape 4', errors: [{ message: 'x', type: 'weird', line: 'a', path: 'relative', count: 0, source: 'javascript:1' }] })!;
    expect(b).toMatchObject({ version: null, ua: 'other' });
    expect(b.errors[0]).toMatchObject({ type: 'error', line: null, path: '/', count: 1, source: null, stack: null });
    for (const body of [null, [], 'x', {}, { errors: 'no' }, { errors: [{ message: '' }, { message: 3 }, null] }]) {
      expect(parseBrowserErrors(body)).toBeNull();
    }
  });

  it(`takes at most ${MAX_ERRORS_PER_BEACON} errors of one beacon; the same message + stack has the same key`, () => {
    const b = parseBrowserErrors({ errors: Array.from({ length: 25 }, (_, i) => ({ message: `e${i % 2}` })) })!;
    expect(b.errors).toHaveLength(MAX_ERRORS_PER_BEACON);
    expect(b.errors[0].key).toBe(b.errors[2].key);
    expect(b.errors[0].key).not.toBe(b.errors[1].key);
  });

  it('BROWSER_ERRORS_* limits: defaults and overrides', () => {
    expect(browserErrorLimitsFromEnv({})).toEqual({ perIpMinute: 30, maxPerVersion: 200, ttlHours: 48 });
    expect([DEFAULT_BROWSER_ERRORS_PER_IP_MINUTE, DEFAULT_BROWSER_ERRORS_MAX_PER_VERSION, DEFAULT_BROWSER_ERRORS_TTL_HOURS]).toEqual([30, 200, 48]);
    expect(browserErrorLimitsFromEnv({ BROWSER_ERRORS_PER_IP_MINUTE: '5', BROWSER_ERRORS_MAX_PER_VERSION: 'x', BROWSER_ERRORS_TTL_HOURS: '1' })).toEqual({
      perIpMinute: 5,
      maxPerVersion: 200,
      ttlHours: 1,
    });
  });
});

// ── a real bundle with its inline source map ────────────────────────────────

const MAIN = "import { boom } from './lib/boom';\ndocument.body.onclick = () => boom();\n";
const BOOM = "export function boom(): never {\n  throw new Error('kaboom');\n}\n";
let bundle: Buffer;
let throwLine: number;
let throwCol: number;

beforeAll(async () => {
  const r = await compile(
    new Map([
      ['src/main.ts', MAIN],
      ['src/lib/boom.ts', BOOM],
      ['index.html', '<html><body><script type="module" src="/main.js"></script></body></html>'],
    ])
  );
  expect(r.ok).toBe(true);
  bundle = Buffer.from(r.outputs.get('main.js')!);
  const lines = bundle.toString('utf8').split('\n');
  throwLine = lines.findIndex((l) => l.includes('throw new Error')) + 1;
  throwCol = lines[throwLine - 1].indexOf('throw') + 1;
});

function bundleLoaders(): Pick<ServeLoaders, 'loadFiles' | 'loadBlobs'> {
  return {
    loadFiles: async () => [
      { path: 'main.js', kind: 'built', sha256: sha(bundle), size: bundle.length },
      { path: 'src/lib/boom.ts', kind: 'source', sha256: sha(BOOM), size: BOOM.length },
    ],
    loadBlobs: async (shas) => new Map(shas.includes(sha(bundle)) ? [[sha(bundle), bundle]] : []),
  };
}

describe('mapping stacks through the source map', () => {
  it('maps every frame of a built bundle to the app source; other frames stay', async () => {
    const bundles = bundlesOf('v_4', bundleLoaders());
    const stack = [
      'Error: kaboom',
      `    at boom (https://shop--preview.drobek.app/main.js?v=3:${throwLine}:${throwCol})`,
      `    at HTMLBodyElement.<anonymous> (/main.js:${throwLine}:${throwCol})`,
      `boom@https://shop--preview.drobek.app/main.js:${throwLine}:${throwCol}`,
      '    at https://esm.sh/react-dom@19.1.0/es2022/react-dom.mjs:4:100',
      '    at other (https://shop--preview.drobek.app/missing.js:1:1)',
    ].join('\n');
    const mapped = await mapStack(stack, bundles);
    const lines = mapped.split('\n');
    expect(lines[1]).toBe('    at boom (src/lib/boom.ts:2:3)');
    expect(lines[2]).toBe('    at HTMLBodyElement.<anonymous> (src/lib/boom.ts:2:3)');
    expect(lines[3]).toBe('boom@src/lib/boom.ts:2:3');
    expect(lines[4]).toBe('    at https://esm.sh/react-dom@19.1.0/es2022/react-dom.mjs:4:100');
    expect(lines[5]).toBe('    at other (https://shop--preview.drobek.app/missing.js:1:1)');
  });

  it('a bundle without a map, a source file and a damaged map leave the stack as it was', async () => {
    const plain = Buffer.from('console.log(1)\n');
    const bundles = bundlesOf('v_x', {
      loadFiles: async (): Promise<StoredFile[]> => [{ path: 'main.js', kind: 'built', sha256: sha(plain), size: plain.length }],
      loadBlobs: async () => new Map([[sha(plain), plain]]),
    });
    const stack = 'Error\n    at x (/main.js:1:1)\n    at y (/src/lib/boom.ts:1:1)';
    expect(await mapStack(stack, bundles)).toBe(stack);
  });
});

// ── the store ───────────────────────────────────────────────────────────────

describe('the store', () => {
  let redis: ReturnType<typeof memoryBrowserErrorsRedis>;
  let store: BrowserErrorStore;
  let clock: number;
  const bundles = async (_appId: string, n: number): Promise<VersionBundles | null> => (n === 4 ? bundlesOf('v_4', bundleLoaders()) : null);
  const batch = (message: string, count = 1, extra: Record<string, unknown> = {}) =>
    parseBrowserErrors({ ua: 'chrome', errors: [{ message, count, path: '/', ...extra }] })!;

  beforeEach(() => {
    redis = memoryBrowserErrorsRedis();
    clock = Date.parse('2026-10-18T10:00:00Z');
    store = browserErrorStore({ redis: () => redis, limits: LIMITS, now: () => clock, bundles });
  });

  it('the same error counts up instead of adding a row; summary and TTL', async () => {
    const stack = `Error: kaboom\n    at boom (/main.js:${throwLine}:${throwCol})`;
    await store.record('app_1', 4, batch('Error: kaboom', 1, { stack, source: '/main.js', line: throwLine, col: throwCol }));
    clock += 30_000;
    await store.record('app_1', 4, batch('Error: kaboom', 2, { stack, source: '/main.js', line: throwLine, col: throwCol }));
    const rows = await store.read('app_1', { since: new Date(0), limit: 100 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      version: 4,
      type: 'error',
      message: 'Error: kaboom',
      count: 3,
      ua: 'chrome',
      source: 'src/lib/boom.ts:2:3',
      at: '2026-10-18T10:00:30.000Z',
      first_seen: '2026-10-18T10:00:00.000Z',
    });
    expect(rows[0].stack).toBe('Error: kaboom\n    at boom (src/lib/boom.ts:2:3)');
    expect(await store.summary('app_1', 4)).toEqual({ count: 1, occurrences: 3, latest_at: '2026-10-18T10:00:30.000Z' });
    expect(await store.summary('app_1', 5)).toEqual({ count: 0, occurrences: 0, latest_at: null });
    expect(redis.ttl.get('drobek:browser-errors:app_1:v4')).toBe(48 * 3600);
    expect(redis.ttl.get('drobek:browser-errors:app_1')).toBe(48 * 3600);
  });

  it(`keeps at most maxPerVersion distinct errors per version; known ones still count up`, async () => {
    for (const m of ['a', 'b', 'c', 'd']) await store.record('app_1', 4, batch(m));
    await store.record('app_1', 4, batch('a'));
    const rows = await store.read('app_1', { since: new Date(0), limit: 100 });
    expect(rows.map((r) => r.message).sort()).toEqual(['a', 'b', 'c']);
    expect(rows.find((r) => r.message === 'a')!.count).toBe(2);
    await store.record('app_1', 5, batch('d'));
    expect((await store.read('app_1', { since: new Date(0), limit: 100 })).map((r) => r.message)).toContain('d');
  });

  it('newest first, across versions, within `since`, at most `limit`; a version filter', async () => {
    await store.record('app_1', 3, batch('old'));
    clock += 60_000;
    await store.record('app_1', 4, batch('new'));
    const all = await store.read('app_1', { since: new Date(0), limit: 100 });
    expect(all.map((r) => [r.version, r.message])).toEqual([
      [4, 'new'],
      [3, 'old'],
    ]);
    expect((await store.read('app_1', { since: new Date(clock - 1000), limit: 100 })).map((r) => r.message)).toEqual(['new']);
    expect(await store.read('app_1', { since: new Date(0), limit: 1 })).toHaveLength(1);
    expect((await store.read('app_1', { since: new Date(0), limit: 100, version: 3 })).map((r) => r.message)).toEqual(['old']);
    expect(await store.read('app_2', { since: new Date(0), limit: 100 })).toEqual([]);
  });
});

// ── the beacon through the handler ──────────────────────────────────────────

describe('POST /__drobek/preview/errors', () => {
  let app: ServeApp;
  let configs: Map<number, string>;
  let redis: ReturnType<typeof memoryBrowserErrorsRedis>;
  let store: BrowserErrorStore;
  let ipAllowed: boolean;
  const SECRET = 'k'.repeat(64);

  const loaders: ServeLoaders = {
    async resolve(target: AppHostTarget) {
      if (target.slug !== 'shop') return { app: null, version: null };
      const n = target.kind === 'version' ? target.number : 4;
      return { app, version: configs.has(n) ? { id: `v_${n}`, number: n } : null };
    },
    async loadFiles(versionId) {
      const n = Number(versionId.slice(2));
      const config = configs.get(n) ?? '{}';
      return [{ path: 'drobek.json', kind: 'source', sha256: sha(config), size: config.length }];
    },
    async loadBlobs(shas) {
      return new Map([...configs.values()].filter((c) => shas.includes(sha(c))).map((c) => [sha(c), Buffer.from(c)]));
    },
    async loadPasswordHash() {
      return null;
    },
  };

  function deps(): HandlerDeps {
    return {
      store: new ServeStore({ loaders }),
      accessSecret: SECRET,
      secureCookies: false,
      allowUnlockAttempt: async () => true,
      preview: { script: Buffer.from(''), hash: 'h', uploadOrigin: null },
      browserErrors: (req, a, v) => takeBrowserErrorBeacon(req, a, v, { store, limits: LIMITS, allowIp: async () => ipAllowed }),
      platform: async () => ({ status: 404, headers: {}, body: 'platform' }),
    };
  }

  function post(target: AppHostTarget, body: unknown, headers: Record<string, string> = {}): AppRequest {
    const raw = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h: Record<string, string> = { 'content-type': 'text/plain;charset=UTF-8', ...headers };
    return {
      method: 'POST',
      target,
      path: PREVIEW_ERRORS_PATH,
      query: '',
      header: (n) => h[n.toLowerCase()] ?? null,
      readForm: async () => null,
      readBody: async (limit) => (raw.length > limit ? 'too_large' : raw),
      clientIp: '203.0.113.9',
    };
  }

  const ERR = (version: number | null = 4) => ({ version, ua: 'chrome', errors: [{ type: 'error', message: 'TypeError: x is undefined', path: '/' }] });
  const rows = () => store.read('app_1', { since: new Date(0), limit: 100 });
  const PREVIEW: AppHostTarget = { kind: 'preview', slug: 'shop' };

  beforeEach(() => {
    app = { id: 'app_1', slug: 'shop', workspaceId: 'ws_1', visibility: 'public', frameAncestors: null };
    configs = new Map([
      [3, '{}'],
      [4, '{}'],
      [5, '{"browserErrors": false}'],
    ]);
    redis = memoryBrowserErrorsRedis();
    store = browserErrorStore({ redis: () => redis, limits: LIMITS, bundles: async () => null });
    ipAllowed = true;
  });

  it('stores the errors of a preview page under its version and answers 204', async () => {
    const r = await handleAppRequest(post(PREVIEW, ERR(3)), deps());
    expect(r.status).toBe(204);
    expect(r.body).toBeNull();
    expect((await rows()).map((e) => [e.version, e.message])).toEqual([[3, 'TypeError: x is undefined']]);
  });

  it('a version host files under its own version; a page naming a version the host never served counts as the served one', async () => {
    await handleAppRequest(post({ kind: 'version', slug: 'shop', number: 3 }, ERR(4)), deps());
    await handleAppRequest(post(PREVIEW, { ...ERR(99), errors: [{ message: 'later' }] }), deps());
    expect((await rows()).map((e) => [e.version, e.message]).sort()).toEqual([
      [3, 'TypeError: x is undefined'],
      [4, 'later'],
    ]);
  });

  it('the production host and a custom domain have no such endpoint (404, nothing stored)', async () => {
    for (const t of [{ kind: 'prod', slug: 'shop' }, { kind: 'custom', slug: 'shop', hostname: 'shop.example.com' }] as AppHostTarget[]) {
      expect((await handleAppRequest(post(t, ERR()), deps())).status, t.kind).toBe(404);
    }
    expect(await rows()).toEqual([]);
  });

  it('dropped, still 204: "browserErrors": false, a locked password gate, another origin, past the per-IP budget, junk', async () => {
    const d = deps();
    expect((await handleAppRequest(post({ kind: 'version', slug: 'shop', number: 5 }, ERR()), d)).status).toBe(204);
    expect((await handleAppRequest(post(PREVIEW, ERR(), { origin: 'https://evil.example' }), d)).status).toBe(204);
    expect((await handleAppRequest(post(PREVIEW, ERR(), { 'sec-fetch-site': 'cross-site' }), d)).status).toBe(204);
    expect((await handleAppRequest(post(PREVIEW, 'not json'), d)).status).toBe(204);
    expect((await handleAppRequest(post(PREVIEW, 'x'.repeat(20_000)), d)).status).toBe(204);
    ipAllowed = false;
    expect((await handleAppRequest(post(PREVIEW, ERR()), d)).status).toBe(204);
    ipAllowed = true;
    app = { ...app, visibility: 'password' };
    const locked = await handleAppRequest(post(PREVIEW, ERR()), deps());
    expect(locked.status).toBe(204);
    expect(await rows()).toEqual([]);

    const cookie = `${appAccessCookieName(false)}=${mintAppAccessToken('app_1', SECRET)}`;
    expect((await handleAppRequest(post(PREVIEW, ERR(), { cookie, origin: 'http://shop--preview.apps.localhost', host: 'shop--preview.apps.localhost' }), deps())).status).toBe(204);
    expect(await rows()).toHaveLength(1);
  });

  it('the per-IP budget is counted per app and client IP', async () => {
    const seen: string[] = [];
    await takeBrowserErrorBeacon(post(PREVIEW, ERR()), app, { id: 'v_4', number: 4 }, {
      store,
      limits: LIMITS,
      allowIp: async (appId, ip, perMinute) => {
        seen.push(`${appId} ${ip} ${perMinute}`);
        return true;
      },
    });
    expect(seen).toEqual(['app_1 203.0.113.9 30']);
  });
});
