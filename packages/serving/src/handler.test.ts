/**
 * The app-host handler against an in-memory model of apps/versions/blobs
 * (the real ServeStore caching logic, fake loaders). The DB queries behind the
 * loaders are covered by store.test.ts (PGlite).
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppHostTarget } from '@drobek/apps';
import { APP_CSP, appCsp } from './csp.js';
import { BEACON_PATH, handleAppRequest, type AppRequest, type HandlerDeps } from './handler.js';
import type { StoredFile } from './manifest.js';
import { UNLOCK_PATH } from './pages.js';
import { APP_ACCESS_COOKIE, hashAppPassword, mintAppAccessToken } from './password.js';
import { ServeStore, type ServeApp, type ServeLoaders } from './store.server.js';
import { emitLocalAppChanged } from '@drobek/apps';
import { subscribeServeCache } from './subscriber.server.js';
import { UnknownHostLimiter } from './unknown-host.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

interface FakeVersion {
  id: string;
  ok: boolean;
  files: Record<string, { content: string; kind: 'source' | 'built' }>;
}
interface FakeApp {
  app: ServeApp;
  published: number | null;
  versions: Map<number, FakeVersion>;
  passwordHash: string | null;
}

const INDEX_V1 = '<!doctype html><h1>v1</h1><script type="module" src="/main.js"></script>';
const INDEX_V2 = '<!doctype html><h1>v2</h1><script type="module" src="/main.js"></script>';
const MAIN_JS = 'import { createRoot } from "https://esm.sh/react-dom@19.1.0/client";';

function version(id: string, ok: boolean, index: string, js = MAIN_JS): FakeVersion {
  return {
    id,
    ok,
    files: {
      'index.html': { content: index, kind: 'source' },
      'src/main.tsx': { content: 'export {}', kind: 'source' },
      'drobek.json': { content: '{}', kind: 'source' },
      'src/styles.css': { content: 'body{}', kind: 'source' },
      ...(ok ? { 'main.js': { content: js, kind: 'built' as const } } : {}),
    },
  };
}

let model: Map<string, FakeApp>;
let calls: { resolve: number; files: number; blobs: number };

const loaders: ServeLoaders = {
  async resolve(target: AppHostTarget) {
    calls.resolve++;
    const a = model.get(target.slug);
    if (!a) return { app: null, version: null };
    let n: number | null = null;
    if (target.kind === 'prod' || target.kind === 'custom') n = a.published;
    else if (target.kind === 'preview') n = Math.max(0, ...[...a.versions].filter(([, v]) => v.ok).map(([k]) => k)) || null;
    else n = a.versions.get(target.number)?.ok ? target.number : null;
    const v = n === null ? null : a.versions.get(n)!;
    return { app: a.app, version: v ? { id: v.id, number: n! } : null };
  },
  async loadFiles(versionId) {
    calls.files++;
    for (const a of model.values()) {
      for (const v of a.versions.values()) {
        if (v.id === versionId) {
          return Object.entries(v.files).map(
            ([path, f]): StoredFile => ({ path, kind: f.kind, sha256: sha(f.content), size: f.content.length })
          );
        }
      }
    }
    return [];
  },
  async loadBlobs(shas) {
    calls.blobs++;
    const out = new Map<string, Buffer>();
    for (const a of model.values())
      for (const v of a.versions.values())
        for (const f of Object.values(v.files)) if (shas.includes(sha(f.content))) out.set(sha(f.content), Buffer.from(f.content));
    return out;
  },
  async loadPasswordHash(appId) {
    return [...model.values()].find((a) => a.app.id === appId)?.passwordHash ?? null;
  },
};

const SECRET = 'k'.repeat(64);
let store: ServeStore;
let attempts: number;
let deps: HandlerDeps;
let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashAppPassword('open sesame');
});

beforeEach(() => {
  calls = { resolve: 0, files: 0, blobs: 0 };
  model = new Map([
    [
      'shop',
      {
        app: { id: 'app_shop', slug: 'shop', workspaceId: 'ws_1', visibility: 'public', frameAncestors: null },
        published: 1,
        versions: new Map([
          [1, version('v_1', true, INDEX_V1)],
          [2, version('v_2', true, INDEX_V2)],
          [3, version('v_3', false, '<h1>broken</h1>')],
        ]),
        passwordHash: null,
      },
    ],
    [
      'draft',
      {
        app: { id: 'app_draft', slug: 'draft', workspaceId: 'ws_1', visibility: 'public', frameAncestors: null },
        published: null,
        versions: new Map([[1, version('d_1', true, INDEX_V1)]]),
        passwordHash: null,
      },
    ],
    [
      'vault',
      {
        app: { id: 'app_vault', slug: 'vault', workspaceId: 'ws_1', visibility: 'password', frameAncestors: null },
        published: 1,
        versions: new Map([[1, version('p_1', true, '<h1>secret</h1>')]]),
        passwordHash: null,
      },
    ],
  ]);
  model.get('vault')!.passwordHash = passwordHash;
  store = new ServeStore({ loaders });
  attempts = 0;
  deps = {
    store,
    accessSecret: SECRET,
    allowUnlockAttempt: async () => ++attempts <= 3,
  };
});

function req(
  target: AppHostTarget | null,
  path = '/',
  opts: { method?: string; query?: string; headers?: Record<string, string>; form?: Record<string, string>; body?: string } = {}
): AppRequest {
  const headers = Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method: opts.method ?? 'GET',
    target,
    path,
    query: opts.query ?? '',
    header: (n) => headers[n.toLowerCase()] ?? null,
    readForm: async () => (opts.form ? new URLSearchParams(opts.form) : null),
    readBody: async () => (opts.body === undefined ? null : Buffer.from(opts.body)),
    clientIp: '203.0.113.9',
  };
}

const prod = (slug: string): AppHostTarget => ({ kind: 'prod', slug });
const preview = (slug: string): AppHostTarget => ({ kind: 'preview', slug });
const ver = (slug: string, number: number): AppHostTarget => ({ kind: 'version', slug, number });
const text = (b: unknown) => (b === null ? '' : String(b)); // Buffer → UTF-8

describe('which version a host serves', () => {
  it('preview = the newest version that compiled; prod = the published one; --vN = exactly N', async () => {
    expect(text((await handleAppRequest(req(preview('shop')), deps)).body)).toContain('<h1>v2</h1>');
    expect(text((await handleAppRequest(req(prod('shop')), deps)).body)).toContain('<h1>v1</h1>');
    expect(text((await handleAppRequest(req(ver('shop', 2)), deps)).body)).toContain('<h1>v2</h1>');
    expect(text((await handleAppRequest(req(ver('shop', 1)), deps)).body)).toContain('<h1>v1</h1>');
  });

  it('a version that did not compile, or does not exist, is a 404 on its host', async () => {
    for (const n of [3, 9]) {
      const r = await handleAppRequest(req(ver('shop', n)), deps);
      expect(r.status).toBe(404);
      expect(text(r.body)).toContain('does not exist or did not compile');
    }
  });

  it('an unpublished app answers the "not published" page on its production host', async () => {
    const r = await handleAppRequest(req(prod('draft')), deps);
    expect(r.status).toBe(404);
    expect(text(r.body)).toContain('Not published yet');
    expect((await handleAppRequest(req(preview('draft')), deps)).status).toBe(200);
  });

  it('an unknown slug or a malformed app host is a 404', async () => {
    expect((await handleAppRequest(req(prod('nope')), deps)).status).toBe(404);
    expect((await handleAppRequest(req(null), deps)).status).toBe(404);
  });
});

describe('which file a path serves', () => {
  it('built main.js is served; TS sources and drobek.json are not; other sources are', async () => {
    const js = await handleAppRequest(req(preview('shop'), '/main.js'), deps);
    expect(js.status).toBe(200);
    expect(js.headers['Content-Type']).toBe('text/javascript; charset=utf-8');
    expect(text(js.body)).toContain('https://esm.sh/');
    expect((await handleAppRequest(req(preview('shop'), '/src/main.tsx'), deps)).status).toBe(404);
    expect((await handleAppRequest(req(preview('shop'), '/drobek.json'), deps)).status).toBe(404);
    expect((await handleAppRequest(req(preview('shop'), '/src/styles.css'), deps)).status).toBe(200);
  });

  it('SPA fallback for extension-less paths; a missing asset is a 404', async () => {
    const deep = await handleAppRequest(req(preview('shop'), '/settings/profile'), deps);
    expect(deep.status).toBe(200);
    expect(text(deep.body)).toContain('<h1>v2</h1>');
    expect((await handleAppRequest(req(preview('shop'), '/logo.png'), deps)).status).toBe(404);
  });

  it('no traversal, encoded or not', async () => {
    for (const p of ['/../drobek.json', '/src/%2e%2e/drobek.json', '/src%2fmain.tsx', '/%2e%2e%2fetc/passwd', '/a%00.js']) {
      expect((await handleAppRequest(req(preview('shop'), p), deps)).status, p).toBe(404);
    }
  });
});

describe('caching', () => {
  it('ETag = quoted sha256; If-None-Match → 304 with no body', async () => {
    const first = await handleAppRequest(req(preview('shop'), '/main.js'), deps);
    expect(first.headers.ETag).toBe(`"${sha(MAIN_JS)}"`);
    const second = await handleAppRequest(
      req(preview('shop'), '/main.js', { headers: { 'If-None-Match': first.headers.ETag } }),
      deps
    );
    expect(second.status).toBe(304);
    expect(second.body).toBeNull();
    expect(second.headers['Content-Security-Policy']).toBe(APP_CSP);
  });

  it('Cache-Control: HTML revalidates, JS with a hash query is immutable', async () => {
    const html = await handleAppRequest(req(preview('shop')), deps);
    expect(html.headers['Cache-Control']).toBe('public, max-age=0, must-revalidate');
    const js = await handleAppRequest(req(preview('shop'), '/main.js', { query: 'v=0123abcd' }), deps);
    expect(js.headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
  });

  it('host resolution, manifests and bytes are cached; bust(slug) re-resolves', async () => {
    await handleAppRequest(req(preview('shop'), '/main.js'), deps);
    await handleAppRequest(req(preview('shop'), '/main.js'), deps);
    expect(calls).toEqual({ resolve: 1, files: 1, blobs: 1 });

    // A new version compiles: without a bust the host still serves the cached one …
    model.get('shop')!.versions.set(4, version('v_4', true, '<h1>v4</h1>'));
    expect(text((await handleAppRequest(req(preview('shop')), deps)).body)).toContain('<h1>v2</h1>');
    // … the app-changed event busts it: the FIRST request after it is new.
    store.bust('shop');
    expect(text((await handleAppRequest(req(preview('shop')), deps)).body)).toContain('<h1>v4</h1>');
  });

  it('the host-resolution TTL is a backstop for changes no event announced', async () => {
    let now = 1_000;
    const s = new ServeStore({ loaders, now: () => now, resolveTtlMs: 60_000 });
    const d = { ...deps, store: s };
    await handleAppRequest(req(prod('shop')), d);
    model.get('shop')!.published = 2;
    expect(text((await handleAppRequest(req(prod('shop')), d)).body)).toContain('<h1>v1</h1>');
    now += 60_001;
    expect(text((await handleAppRequest(req(prod('shop')), d)).body)).toContain('<h1>v2</h1>');
  });
});

describe('headers on every response (snapshot)', () => {
  const PREVIEW_SECURITY = {
    'Content-Security-Policy': APP_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex',
  };

  it('preview 200 HTML', async () => {
    const r = await handleAppRequest(req(preview('shop')), deps);
    expect(r.headers).toEqual({
      ...PREVIEW_SECURITY,
      'X-Drobek-App': 'shop',
      'Content-Type': 'text/html; charset=utf-8',
      ETag: `"${sha(INDEX_V2)}"`,
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Content-Length': String(Buffer.byteLength(INDEX_V2)),
    });
  });

  it('prod 200 HTML (indexable: no X-Robots-Tag)', async () => {
    const r = await handleAppRequest(req(prod('shop')), deps);
    expect(r.headers).toEqual({
      'Content-Security-Policy': APP_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Drobek-App': 'shop',
      'Content-Type': 'text/html; charset=utf-8',
      ETag: `"${sha(INDEX_V1)}"`,
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Content-Length': String(Buffer.byteLength(INDEX_V1)),
    });
  });

  it('version hosts are noindex too', async () => {
    expect((await handleAppRequest(req(ver('shop', 1)), deps)).headers['X-Robots-Tag']).toBe('noindex');
  });

  it('404, 405 and the password page carry the CSP too', async () => {
    const r404 = await handleAppRequest(req(preview('shop'), '/src/main.tsx'), deps);
    expect(r404.headers).toEqual({
      ...PREVIEW_SECURITY,
      'X-Drobek-App': 'shop',
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    // No app behind the host → no X-Drobek-App.
    expect((await handleAppRequest(req(prod('nope')), deps)).headers['X-Drobek-App']).toBeUndefined();
    const r405 = await handleAppRequest(req(preview('shop'), '/', { method: 'PUT' }), deps);
    expect(r405.status).toBe(405);
    expect(r405.headers).toMatchObject({ ...PREVIEW_SECURITY, Allow: 'GET, HEAD' });
    const r401 = await handleAppRequest(req(prod('vault')), deps);
    expect(r401.status).toBe(401);
    expect(r401.headers['Content-Security-Policy']).toBe(APP_CSP);
    const post = await handleAppRequest(req(preview('shop'), '/', { method: 'POST' }), deps);
    expect(post.status).toBe(405);
  });

  it('HEAD: the same headers, no body', async () => {
    const r = await handleAppRequest(req(preview('shop'), '/main.js', { method: 'HEAD' }), deps);
    expect(r.status).toBe(200);
    expect(r.body).toBeNull();
    expect(r.headers['Content-Length']).toBe(String(MAIN_JS.length));
  });

  it('a valid frame_ancestors override reaches the CSP; an invalid one falls back to none', async () => {
    model.get('shop')!.app.frameAncestors = 'https://intranet.example.com';
    let r = await handleAppRequest(req(prod('shop')), deps);
    expect(r.headers['Content-Security-Policy']).toBe(appCsp('https://intranet.example.com'));
    store.bust('shop');
    model.get('shop')!.app.frameAncestors = "*; script-src 'unsafe-eval'";
    r = await handleAppRequest(req(prod('shop')), deps);
    expect(r.headers['Content-Security-Policy']).toBe(APP_CSP);
  });

  it('NSO-342: the dashboard origin may always frame the app (thumbnail), next to an override', async () => {
    const withDash = { ...deps, dashboardOrigin: 'https://drobek.example.com' };
    store.bust('shop');
    model.get('shop')!.app.frameAncestors = null;
    let r = await handleAppRequest(req(prod('shop')), withDash);
    expect(r.headers['Content-Security-Policy']).toBe(appCsp('https://drobek.example.com'));
    // The password page and the 404 of a missing version carry it too (one header set per app).
    r = await handleAppRequest(req(prod('vault')), withDash);
    expect(r.status).toBe(401);
    expect(r.headers['Content-Security-Policy']).toBe(appCsp('https://drobek.example.com'));
    store.bust('shop');
    model.get('shop')!.app.frameAncestors = 'https://intranet.example.com';
    r = await handleAppRequest(req(prod('shop')), withDash);
    expect(r.headers['Content-Security-Policy']).toBe(appCsp('https://intranet.example.com https://drobek.example.com'));
    store.bust('shop');
    model.get('shop')!.app.frameAncestors = null;
  });
});

describe('isolation from the dashboard session', () => {
  it('a dashboard session cookie changes nothing and no Set-Cookie is ever sent', async () => {
    const plain = await handleAppRequest(req(prod('shop')), deps);
    for (const cookie of [
      `__Host-drobek_session=${'a'.repeat(96)}`,
      `drobek_session=${'a'.repeat(96)}`,
      `drobek_session=${'a'.repeat(96)}; __Host-drobek_session=${'b'.repeat(96)}`,
    ]) {
      const r = await handleAppRequest(req(prod('shop'), '/', { headers: { Cookie: cookie } }), deps);
      expect(r).toEqual(plain);
      expect(Object.keys(r.headers).map((h) => h.toLowerCase())).not.toContain('set-cookie');
    }
  });

  it('a dashboard session does NOT unlock a password app', async () => {
    const r = await handleAppRequest(
      req(prod('vault'), '/', { headers: { Cookie: `__Host-drobek_session=${'a'.repeat(96)}` } }),
      deps
    );
    expect(r.status).toBe(401);
  });
});

describe('password gate', () => {
  const unlock = (form: Record<string, string>) =>
    handleAppRequest(req(prod('vault'), UNLOCK_PATH, { method: 'POST', form }), deps);

  it('locked: 401 page with a form posting to the unlock path, carrying where to return', async () => {
    const r = await handleAppRequest(req(prod('vault'), '/reports', { query: 'q=1' }), deps);
    expect(r.status).toBe(401);
    expect(r.headers['Cache-Control']).toBe('no-store');
    const html = text(r.body);
    expect(html).toContain(`action="${UNLOCK_PATH}"`);
    expect(html).toContain('name="password"');
    expect(html).toContain('value="/reports?q=1"');
    expect(html).not.toContain('secret');
  });

  it('wrong password → 401 with an error; right password → 303 + host-only cookie → 200', async () => {
    const wrong = await unlock({ password: 'nope', next: '/' });
    expect(wrong.status).toBe(401);
    expect(text(wrong.body)).toContain('Incorrect password');
    expect(wrong.headers['Set-Cookie']).toBeUndefined();

    const right = await unlock({ password: 'open sesame', next: '/reports?q=1' });
    expect(right.status).toBe(303);
    expect(right.headers.Location).toBe('/reports?q=1');
    const setCookie = right.headers['Set-Cookie'];
    expect(setCookie).toMatch(new RegExp(`^${APP_ACCESS_COOKIE}=[^;]+; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=43200$`));
    expect(setCookie.toLowerCase()).not.toContain('domain');

    const cookie = setCookie.split(';')[0];
    const open = await handleAppRequest(req(prod('vault'), '/', { headers: { Cookie: cookie } }), deps);
    expect(open.status).toBe(200);
    expect(text(open.body)).toContain('<h1>secret</h1>');
    // Gated bytes are never publicly cacheable.
    expect(open.headers['Cache-Control']).toBe('private, max-age=0, must-revalidate');
  });

  it('plain-http dev (secureCookies: false): unprefixed host-only cookie, the __Host- name is not read', async () => {
    const d = { ...deps, secureCookies: false };
    const right = await handleAppRequest(
      req(prod('vault'), UNLOCK_PATH, { method: 'POST', form: { password: 'open sesame', next: '/' } }),
      d
    );
    expect(right.status).toBe(303);
    expect(right.headers['Set-Cookie']).toMatch(/^drobek_app_access=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/);
    const value = right.headers['Set-Cookie'].split(';')[0].split('=').slice(1).join('=');
    const open = await handleAppRequest(req(prod('vault'), '/', { headers: { Cookie: `drobek_app_access=${value}` } }), d);
    expect(open.status).toBe(200);
    const prefixed = await handleAppRequest(
      req(prod('vault'), '/', { headers: { Cookie: `${APP_ACCESS_COOKIE}=${value}` } }),
      d
    );
    expect(prefixed.status).toBe(401);
    // …and the default (secure) mode never reads the unprefixed name.
    const plainName = await handleAppRequest(
      req(prod('vault'), '/', { headers: { Cookie: `drobek_app_access=${value}` } }),
      deps
    );
    expect(plainName.status).toBe(401);
  });

  it('never redirects off the host after unlocking', async () => {
    for (const next of ['https://evil.example', '//evil.example', '/\\evil.example', 'relative']) {
      attempts = 0;
      const r = await unlock({ password: 'open sesame', next });
      expect(r.headers.Location, next).toBe('/');
    }
  });

  it("a token for another app, a forged or an expired token doesn't open it", async () => {
    const other = mintAppAccessToken('app_shop', SECRET);
    const forged = mintAppAccessToken('app_vault', 'x'.repeat(64));
    const expired = mintAppAccessToken('app_vault', SECRET, 10, Date.now() - 60_000);
    for (const t of [other, forged, expired, 'garbage']) {
      const r = await handleAppRequest(req(prod('vault'), '/', { headers: { Cookie: `${APP_ACCESS_COOKIE}=${t}` } }), deps);
      expect(r.status).toBe(401);
    }
  });

  it('unlock attempts are rate limited (429)', async () => {
    for (let i = 0; i < 3; i++) expect((await unlock({ password: 'nope' })).status).toBe(401);
    const limited = await unlock({ password: 'open sesame' });
    expect(limited.status).toBe(429);
    expect(limited.headers['Set-Cookie']).toBeUndefined();
  });

  it('fails closed without a signing key', async () => {
    const d = { ...deps, accessSecret: null };
    const token = mintAppAccessToken('app_vault', SECRET);
    expect(
      (await handleAppRequest(req(prod('vault'), '/', { headers: { Cookie: `${APP_ACCESS_COOKIE}=${token}` } }), d)).status
    ).toBe(401);
    expect(
      (await handleAppRequest(req(prod('vault'), UNLOCK_PATH, { method: 'POST', form: { password: 'open sesame' } }), d))
        .status
    ).toBe(500);
  });

  it('the gate applies to the preview and version hosts too', async () => {
    expect((await handleAppRequest(req(preview('vault')), deps)).status).toBe(401);
    expect((await handleAppRequest(req(ver('vault', 1)), deps)).status).toBe(401);
  });

  it('the unlock path of a public app just redirects', async () => {
    const r = await handleAppRequest(req(prod('shop'), UNLOCK_PATH, { method: 'POST', form: { password: 'x' } }), deps);
    expect(r.status).toBe(303);
    expect(r.headers['Set-Cookie']).toBeUndefined();
  });
});

describe('platform paths (/__drobek/*, M1-01)', () => {
  function withPlatform(): { d: HandlerDeps; seen: { path: string; method: string; app: string; body: string | null }[] } {
    const seen: { path: string; method: string; app: string; body: string | null }[] = [];
    const d: HandlerDeps = {
      ...deps,
      platform: async (r, ctx) => {
        const b = await r.readBody(1024);
        seen.push({ path: r.path, method: r.method, app: ctx.app.id, body: Buffer.isBuffer(b) ? b.toString() : null });
        return { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Security-Policy': 'bogus' }, body: '{"ok":true}' };
      },
    };
    return { d, seen };
  }

  it('go to the platform handler with any method, after the app is resolved; security headers win', async () => {
    const { d, seen } = withPlatform();
    const r = await handleAppRequest(req(preview('shop'), '/__drobek/v1/hello/wave', { method: 'POST', body: '{"name":"a"}' }), d);
    expect(r.status).toBe(200);
    // A module CSP is only ever a SECOND policy next to the app's (NSO-325).
    expect(r.headers['Content-Security-Policy']).toBe(`${APP_CSP}, bogus`);
    expect(r.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(seen).toEqual([{ path: '/__drobek/v1/hello/wave', method: 'POST', app: 'app_shop', body: '{"name":"a"}' }]);
    // an app that has no version yet still reaches the platform (the SDK is independent of the app's files)
    expect((await handleAppRequest(req(prod('draft'), '/__drobek/sdk.js'), d)).status).toBe(200);
  });

  it('NSO-325: a module CSP (e.g. `sandbox` on served files) is added after the app CSP, whatever its casing; other security headers stay the app\'s', async () => {
    const d: HandlerDeps = {
      ...deps,
      platform: async () => ({
        status: 200,
        headers: { 'Content-Type': 'image/png', 'content-security-policy': 'sandbox', 'X-Content-Type-Options': 'sniff-away', 'Referrer-Policy': 'unsafe-url' },
        body: 'png',
      }),
    };
    const r = await handleAppRequest(req(prod('shop'), '/__drobek/v1/files/abc12345'), d);
    expect(r.headers['Content-Security-Policy']).toBe(`${APP_CSP}, sandbox`);
    expect(Object.keys(r.headers).filter((k) => k.toLowerCase() === 'content-security-policy')).toEqual(['Content-Security-Policy']);
    expect(r.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(r.headers['Referrer-Policy']).toBe('no-referrer');
    // Without a module CSP the app CSP stands alone.
    const plain = await handleAppRequest(req(prod('shop'), '/__drobek/v1/files/abc12345'), { ...deps, platform: async () => ({ status: 200, headers: {}, body: 'x' }) });
    expect(plain.headers['Content-Security-Policy']).toBe(APP_CSP);
    // An empty module CSP adds nothing.
    const empty = await handleAppRequest(req(prod('shop'), '/__drobek/v1/x'), {
      ...deps,
      platform: async () => ({ status: 200, headers: { 'Content-Security-Policy': '  ' }, body: 'x' }),
    });
    expect(empty.headers['Content-Security-Policy']).toBe(APP_CSP);
  });

  it('a missing app never reaches the platform; a locked app answers JSON 401 password_required', async () => {
    const { d, seen } = withPlatform();
    expect((await handleAppRequest(req(prod('nope'), '/__drobek/sdk.js'), d)).status).toBe(404);
    const locked = await handleAppRequest(req(prod('vault'), '/__drobek/v1/hello'), d);
    expect(locked.status).toBe(401);
    expect(JSON.parse(text(locked.body))).toMatchObject({ error: 'password_required' });
    expect(seen).toEqual([]);
    const token = mintAppAccessToken('app_vault', SECRET);
    const open = await handleAppRequest(req(prod('vault'), '/__drobek/v1/hello', { headers: { Cookie: `${APP_ACCESS_COOKIE}=${token}` } }), d);
    expect(open.status).toBe(200);
  });

  it('the unlock POST stays the password gate; without a platform handler the paths are plain files', async () => {
    const { d, seen } = withPlatform();
    expect((await handleAppRequest(req(prod('shop'), UNLOCK_PATH, { method: 'POST', form: { password: 'x' } }), d)).status).toBe(303);
    expect(seen).toEqual([]);
    expect((await handleAppRequest(req(prod('shop'), '/__drobek/v1/hello', { method: 'POST' }), deps)).status).toBe(405);
    expect((await handleAppRequest(req(prod('shop'), '/__drobek/sdk.js'), deps)).status).toBe(404);
  });
});

describe('the browser error beacon (/__drobek/v1/_beacon, M1-07)', () => {
  function withBeacon(): { d: HandlerDeps; beacons: string[]; platform: string[]; signals: string[] } {
    const beacons: string[] = [];
    const platform: string[] = [];
    const signals: string[] = [];
    const d: HandlerDeps = {
      ...deps,
      signal: (appId, kind) => signals.push(`${appId}:${kind}`),
      platform: async (r) => {
        platform.push(r.path);
        return { status: 200, headers: {}, body: '{}' };
      },
      beacon: async (_r, app) => {
        beacons.push(app.id);
        return { status: 204, headers: { 'Cache-Control': 'no-store', 'Content-Security-Policy': 'bogus' }, body: null };
      },
    };
    return { d, beacons, platform, signals };
  }

  it('goes to core (never to a module) for the app behind the host; not counted as a request', async () => {
    const { d, beacons, platform, signals } = withBeacon();
    const r = await handleAppRequest(req(preview('shop'), BEACON_PATH, { method: 'POST', body: '{}' }), d);
    expect(r.status).toBe(204);
    expect(r.headers['Content-Security-Policy']).not.toBe('bogus');
    expect(beacons).toEqual(['app_shop']);
    expect(platform).toEqual([]);
    expect(signals).toEqual([]);
    // an app with no compiled version still reports (the page may be a cached one)
    expect((await handleAppRequest(req(prod('draft'), BEACON_PATH, { method: 'POST', body: '{}' }), d)).status).toBe(204);
  });

  it('a missing app → 404; a locked app → JSON 401 password_required (never stored)', async () => {
    const { d, beacons } = withBeacon();
    expect((await handleAppRequest(req(prod('nope'), BEACON_PATH, { method: 'POST' }), d)).status).toBe(404);
    const locked = await handleAppRequest(req(prod('vault'), BEACON_PATH, { method: 'POST', body: '{}' }), d);
    expect(locked.status).toBe(401);
    expect(JSON.parse(text(locked.body))).toMatchObject({ error: 'password_required' });
    expect(beacons).toEqual([]);
    const token = mintAppAccessToken('app_vault', SECRET);
    const open = await handleAppRequest(
      req(prod('vault'), BEACON_PATH, { method: 'POST', body: '{}', headers: { Cookie: `${APP_ACCESS_COOKIE}=${token}` } }),
      d
    );
    expect(open.status).toBe(204);
    expect(beacons).toEqual(['app_vault']);
  });
});

describe('custom domains (M3-01)', () => {
  const custom = (slug: string, hostname = 'shop.firma.cz'): AppHostTarget => ({ kind: 'custom', slug, hostname });

  it('a verified custom domain serves the PUBLISHED version, indexable, like the production host', async () => {
    const r = await handleAppRequest(req(custom('shop')), deps);
    expect(r.status).toBe(200);
    expect(text(r.body)).toContain('<h1>v1</h1>');
    expect(r.headers['X-Robots-Tag']).toBeUndefined();
    expect(r.headers['Content-Security-Policy']).toBe(APP_CSP);
    // Shares the production host's resolution (one cache entry per slug).
    const before = calls.resolve;
    await handleAppRequest(req(prod('shop')), deps);
    expect(calls.resolve).toBe(before);
  });

  it('an unpublished app is "not published" on its custom domain; the password gate applies', async () => {
    const draft = await handleAppRequest(req(custom('draft', 'draft.firma.cz')), deps);
    expect(draft.status).toBe(404);
    expect(text(draft.body)).toContain('Not published yet');
    expect((await handleAppRequest(req(custom('vault', 'vault.firma.cz')), deps)).status).toBe(401);
  });

  it('with a primary domain the production host 302s there (path + query kept); nothing else redirects', async () => {
    model.get('shop')!.app = { ...model.get('shop')!.app, primaryDomain: 'shop.firma.cz' };
    const d: HandlerDeps = { ...deps, customDomainOrigin: (h) => `http://${h}:3041`, platform: async () => ({ status: 200, headers: {}, body: 'mod' }) };
    const r = await handleAppRequest(req(prod('shop'), '/a/b', { query: 'x=1' }), d);
    expect(r.status).toBe(302);
    expect(r.headers.Location).toBe('http://shop.firma.cz:3041/a/b?x=1');
    expect(r.headers['Content-Security-Policy']).toBe(APP_CSP);
    expect((await handleAppRequest(req(prod('shop'), '/', { method: 'HEAD' }), d)).status).toBe(302);
    // default origin: https, no port
    expect((await handleAppRequest(req(prod('shop')), deps)).headers.Location).toBe('https://shop.firma.cz/');
    // the custom domain itself, preview/version hosts, module paths and POSTs are served in place
    expect((await handleAppRequest(req(custom('shop')), d)).status).toBe(200);
    expect((await handleAppRequest(req(preview('shop')), d)).status).toBe(200);
    expect((await handleAppRequest(req(ver('shop', 2)), d)).status).toBe(200);
    expect(text((await handleAppRequest(req(prod('shop'), '/__drobek/v1/x', { method: 'POST' }), d)).body)).toBe('mod');
  });
});

describe('abuse: report pointer, takedown 451, X-Drobek-App (M4-02)', () => {
  const REPORT = '/.well-known/drobek-report';
  const withReport = (d: HandlerDeps): HandlerDeps => ({
    ...d,
    reportUrl: (host) => `https://drobek.example/report?host=${encodeURIComponent(host)}`,
    termsUrl: 'https://drobek.example/terms',
  });

  it('GET /.well-known/drobek-report on any app host → the report URL for that host (public, 1 h)', async () => {
    const d = withReport(deps);
    const r = await handleAppRequest(req(preview('shop'), REPORT, { headers: { Host: 'Shop--Preview.apps.example.' } }), d);
    expect(r.status).toBe(200);
    expect(r.headers).toMatchObject({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'X-Drobek-App': 'shop',
      'Content-Security-Policy': APP_CSP,
    });
    expect(JSON.parse(text(r.body))).toEqual({
      report_url: 'https://drobek.example/report?host=shop--preview.apps.example',
      app: 'shop',
      terms_url: 'https://drobek.example/terms',
    });
    // An unknown slug / a malformed host still gets the pointer (app: null).
    const none = await handleAppRequest(req(null, REPORT, { headers: { Host: 'a.b.apps.example' } }), d);
    expect(none.status).toBe(200);
    expect(JSON.parse(text(none.body))).toMatchObject({ app: null, report_url: 'https://drobek.example/report?host=a.b.apps.example' });
    // It sits in front of the password gate and the takedown.
    expect((await handleAppRequest(req(prod('vault'), REPORT, { headers: { Host: 'vault.apps.example' } }), d)).status).toBe(200);
    model.get('shop')!.app.lockedReason = 'phishing';
    store.bust('shop');
    expect((await handleAppRequest(req(prod('shop'), REPORT, { headers: { Host: 'shop.apps.example' } }), d)).status).toBe(200);
    // HEAD: headers only.
    expect((await handleAppRequest(req(prod('shop'), REPORT, { method: 'HEAD', headers: { Host: 'shop.apps.example' } }), d)).body).toBeNull();
  });

  it('a taken-down app answers 451 with the terms link on EVERY host and path, before the password gate', async () => {
    model.get('shop')!.app.lockedReason = 'phishing';
    model.get('vault')!.app.lockedReason = 'malware';
    const d = withReport(deps);
    const custom: AppHostTarget = { kind: 'custom', slug: 'shop', hostname: 'shop.firma.cz' };
    for (const target of [prod('shop'), preview('shop'), ver('shop', 1), ver('shop', 2), custom]) {
      for (const path of ['/', '/main.js', '/deep/link']) {
        const r = await handleAppRequest(req(target, path), d);
        expect(r.status, `${JSON.stringify(target)} ${path}`).toBe(451);
        expect(r.headers).toMatchObject({
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Drobek-App': 'shop',
          'Content-Security-Policy': APP_CSP,
          Link: '<https://drobek.example/terms>; rel="blocked-by"',
        });
        expect(text(r.body)).toContain('href="https://drobek.example/terms"');
        expect(text(r.body)).toContain('phishing or credential theft');
      }
    }
    const vault = await handleAppRequest(req(prod('vault')), d);
    expect(vault.status).toBe(451);
    expect(text(vault.body)).not.toContain('password');
    const unlock = await handleAppRequest(req(prod('vault'), UNLOCK_PATH, { method: 'POST', form: { password: 'open sesame' } }), d);
    expect(unlock.status).toBe(451);
    expect(unlock.headers['Set-Cookie']).toBeUndefined();
    const head = await handleAppRequest(req(prod('shop'), '/', { method: 'HEAD' }), d);
    expect(head.status).toBe(451);
    expect(head.body).toBeNull();
  });

  it('platform paths and the beacon of a taken-down app → JSON 451 app_locked_by_admin; nothing reaches them', async () => {
    model.get('shop')!.app.lockedReason = 'spam';
    const hits: string[] = [];
    const d: HandlerDeps = {
      ...withReport(deps),
      platform: async (r) => {
        hits.push(r.path);
        return { status: 200, headers: {}, body: '{}' };
      },
      beacon: async (r) => {
        hits.push(r.path);
        return { status: 204, headers: {}, body: null };
      },
    };
    for (const [path, method] of [['/__drobek/v1/data/items', 'POST'], ['/__drobek/sdk.js', 'GET'], [BEACON_PATH, 'POST']] as const) {
      const r = await handleAppRequest(req(preview('shop'), path, { method, body: '{}' }), d);
      expect(r.status).toBe(451);
      expect(r.headers['X-Drobek-App']).toBe('shop');
      expect(JSON.parse(text(r.body))).toEqual({
        error: 'app_locked_by_admin',
        message: 'This app was taken down by the server operator.',
        details: { reason: 'spam' },
      });
    }
    expect(hits).toEqual([]);
  });

  it('an unknown stored reason shows as "other"; a restored app serves again after the cache bust', async () => {
    model.get('shop')!.app.lockedReason = 'internal note that must not leak';
    const d = withReport(deps);
    const r = await handleAppRequest(req(prod('shop')), d);
    expect(r.status).toBe(451);
    expect(text(r.body)).not.toContain('internal note');
    expect(text(r.body)).toContain('other violation of the terms');
    model.get('shop')!.app.lockedReason = null;
    store.bust('shop');
    expect((await handleAppRequest(req(prod('shop')), d)).status).toBe(200);
  });

  it('a taken-down app with a primary custom domain is 451 on its production host, never a 302', async () => {
    model.get('shop')!.app = { ...model.get('shop')!.app, primaryDomain: 'shop.firma.cz', lockedReason: 'phishing' };
    const r = await handleAppRequest(req(prod('shop')), withReport(deps));
    expect(r.status).toBe(451);
    expect(r.headers.Location).toBeUndefined();
  });
});

describe('unknown hosts: negative cache (NSO-315)', () => {
  it('a repeated unknown slug is ONE lookup for every host of it, until the 30 s TTL ends', async () => {
    let now = 1_000;
    const s = new ServeStore({ loaders, now: () => now });
    const d = { ...deps, store: s };
    for (const t of [prod('ghost'), prod('ghost'), preview('ghost'), ver('ghost', 2)]) {
      expect((await handleAppRequest(req(t), d)).status).toBe(404);
    }
    expect(calls.resolve).toBe(1);
    now += 30_001;
    expect((await handleAppRequest(req(prod('ghost')), d)).status).toBe(404);
    expect(calls.resolve).toBe(2);
  });

  it('a create event makes the new app reachable at once', async () => {
    const s = new ServeStore({ loaders });
    const sub = subscribeServeCache(s, { redis: null });
    try {
      const d = { ...deps, store: s };
      expect((await handleAppRequest(req(preview('fresh')), d)).status).toBe(404);
      model.set('fresh', {
        app: { id: 'app_fresh', slug: 'fresh', workspaceId: 'ws_1', visibility: 'public', frameAncestors: null },
        published: null,
        versions: new Map([[1, version('f_1', true, '<h1>fresh</h1>')]]),
        passwordHash: null,
      });
      // Without an event the miss is still remembered …
      expect((await handleAppRequest(req(preview('fresh')), d)).status).toBe(404);
      // … the create event (createApp) forgets it: the very next request serves the app.
      emitLocalAppChanged({ app_id: 'app_fresh', slug: 'fresh', kind: 'create' });
      expect(text((await handleAppRequest(req(preview('fresh')), d)).body)).toContain('<h1>fresh</h1>');
    } finally {
      await sub.stop();
    }
  });

  it('misses live apart from the positive cache: a random-slug flood never evicts a real app', async () => {
    const s = new ServeStore({ loaders, negativeMaxEntries: 5 });
    const d = { ...deps, store: s };
    await handleAppRequest(req(prod('shop')), d);
    for (let i = 0; i < 50; i++) await handleAppRequest(req(prod(`rnd-${i}`)), d);
    const before = calls.resolve;
    expect((await handleAppRequest(req(prod('shop')), d)).status).toBe(200);
    expect(calls.resolve).toBe(before);
    // Bounded: the newest misses are still cached, the oldest were evicted (looked up again).
    await handleAppRequest(req(prod('rnd-49')), d);
    expect(calls.resolve).toBe(before);
    await handleAppRequest(req(prod('rnd-0')), d);
    expect(calls.resolve).toBe(before + 1);
  });

  it('a custom-host miss is cached too; a domain event forgets it', async () => {
    const domains = new Map<string, { slug: string | null }>();
    let lookups = 0;
    const s = new ServeStore({
      loaders: {
        ...loaders,
        resolveCustomHost: async (h) => {
          lookups++;
          return domains.get(h) ?? null;
        },
      },
    });
    const sub = subscribeServeCache(s, { redis: null });
    try {
      expect(await s.resolveCustomHost('shop.firma.cz')).toBeNull();
      expect(await s.resolveCustomHost('shop.firma.cz')).toBeNull();
      expect(lookups).toBe(1);
      domains.set('shop.firma.cz', { slug: null });
      // A version event of some app does not touch the hostname misses …
      emitLocalAppChanged({ app_id: 'app_shop', slug: 'shop', kind: 'version' });
      expect(await s.resolveCustomHost('shop.firma.cz')).toBeNull();
      // … a domain event does.
      emitLocalAppChanged({ app_id: 'app_shop', slug: 'shop', kind: 'domain' });
      expect(await s.resolveCustomHost('shop.firma.cz')).toEqual({ slug: null });
      expect(lookups).toBe(2);
    } finally {
      await sub.stop();
    }
  });
});

describe('unknown hosts: per-IP limit (NSO-315)', () => {
  function limited(limit = 3) {
    const counts = new Map<string, number>();
    const keys: string[] = [];
    const limiter = new UnknownHostLimiter({
      limit,
      windowMs: 60_000,
      counter: async (key, max) => {
        keys.push(key);
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return n <= max;
      },
    });
    return { d: { ...deps, unknownHosts: limiter } as HandlerDeps, keys };
  }

  it('past the limit an unknown host answers 429 (small body, base headers only)', async () => {
    const { d, keys } = limited(3);
    for (let i = 0; i < 3; i++) expect((await handleAppRequest(req(prod(`nope-${i}`)), d)).status).toBe(404);
    const r = await handleAppRequest(req(prod('nope-3')), d);
    expect(r.status).toBe(429);
    expect(text(r.body)).toBe('Too Many Requests');
    expect(r.headers).toEqual({
      'Content-Security-Policy': APP_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': '60',
    });
    expect(keys).toEqual(Array(4).fill('203.0.113.9'));
    expect((await handleAppRequest(req(prod('nope-4'), '/', { method: 'HEAD' }), d)).body).toBeNull();
  });

  it('while throttled: no lookup for unknown hosts; apps the cache knows as live are still served', async () => {
    const { d } = limited(1);
    await handleAppRequest(req(prod('shop')), d); // cached as a live app
    await handleAppRequest(req(prod('nope-a')), d);
    expect((await handleAppRequest(req(prod('nope-b')), d)).status).toBe(429);
    const before = calls.resolve;
    expect((await handleAppRequest(req(prod('nope-c')), d)).status).toBe(429);
    expect((await handleAppRequest(req(null), d)).status).toBe(429);
    expect(calls.resolve).toBe(before);
    expect((await handleAppRequest(req(prod('shop')), d)).status).toBe(200);
    expect((await handleAppRequest(req(preview('shop')), d)).status).toBe(200);
  });

  it('a malformed app host (no target) counts as unknown too', async () => {
    const { d } = limited(1);
    expect((await handleAppRequest(req(null), d)).status).toBe(404);
    expect((await handleAppRequest(req(null), d)).status).toBe(429);
  });

  it('NSO-309: a client without a recognised IP is never counted (no shared bucket)', async () => {
    const { d, keys } = limited(1);
    for (let i = 0; i < 5; i++) {
      const r = await handleAppRequest({ ...req(prod(`anon-${i}`)), clientIp: null }, d);
      expect(r.status).toBe(404);
    }
    expect(keys).toEqual([]);
  });

  it('a failing counter fails open (the plain 404)', async () => {
    const errors: unknown[] = [];
    const limiter = new UnknownHostLimiter({
      limit: 1,
      counter: async () => {
        throw new Error('redis down');
      },
      onError: (e) => errors.push(e),
    });
    const d = { ...deps, unknownHosts: limiter };
    for (let i = 0; i < 3; i++) expect((await handleAppRequest(req(prod(`x-${i}`)), d)).status).toBe(404);
    expect(errors).toHaveLength(3);
  });

  it('a throttled client still gets the 451 of a taken-down app the cache knows (limiter, then lookup, then 451)', async () => {
    const { d } = limited(1);
    model.get('shop')!.app.lockedReason = 'phishing';
    expect((await handleAppRequest(req(prod('shop')), d)).status).toBe(451); // cached as a live (locked) app
    await handleAppRequest(req(prod('nope-a')), d);
    expect((await handleAppRequest(req(prod('nope-b')), d)).status).toBe(429);
    const r = await handleAppRequest(req(prod('shop')), d);
    expect(r.status).toBe(451);
    expect(r.headers['X-Drobek-App']).toBe('shop');
    // An app the cache has not seen yet is 429 for the throttled client, never a lookup.
    const before = calls.resolve;
    expect((await handleAppRequest(req(prod('vault')), d)).status).toBe(429);
    expect(calls.resolve).toBe(before);
  });

  it('missing files of a known app are never counted', async () => {
    const { d, keys } = limited(1);
    for (let i = 0; i < 5; i++) await handleAppRequest(req(prod('shop'), `/missing-${i}.png`), d);
    expect(keys).toEqual([]);
  });
});

describe('app assets at /<name> (NSO-358)', () => {
  const FILM = Buffer.concat([Buffer.from('....ftypisom'), Buffer.alloc(988, 7)]); // 1000 bytes
  const LOGO = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const UPDATED = new Date('2026-09-20T10:00:00.123Z');
  let opened: Array<{ appId: string; key: string; range?: { start: number; end: number } }>;

  const assetDeps = (d: HandlerDeps = deps): HandlerDeps => ({
    ...d,
    assets: {
      async find(_appId, name) {
        if (name === 'film.mp4') {
          return { name, contentType: 'video/mp4', size: FILM.length, sha256: 'f'.repeat(64), storageKey: 'k'.repeat(32), updatedAt: UPDATED };
        }
        if (name === 'img/logo.svg') {
          return { name, contentType: 'image/svg+xml', size: LOGO.length, sha256: 'a'.repeat(64), storageKey: 's'.repeat(32), updatedAt: UPDATED };
        }
        if (name === 'gone.mp4') {
          return { name, contentType: 'video/mp4', size: 10, sha256: 'b'.repeat(64), storageKey: 'g'.repeat(32), updatedAt: UPDATED };
        }
        return null;
      },
      async open(appId, key, range) {
        opened.push({ appId, key, range });
        if (key === 'g'.repeat(32)) return null;
        const bytes = key === 'k'.repeat(32) ? FILM : LOGO;
        return Readable.from([range ? bytes.subarray(range.start, range.end + 1) : bytes]);
      },
    },
  });
  const bodyOf = async (b: unknown): Promise<Buffer> => {
    const parts: Buffer[] = [];
    for await (const c of b as Readable) parts.push(Buffer.from(c as Buffer));
    return Buffer.concat(parts);
  };

  beforeEach(() => {
    opened = [];
  });

  it('serves the whole file with the sniffed type, Accept-Ranges, ETag and Last-Modified on every host', async () => {
    for (const target of [prod('shop'), preview('shop'), ver('shop', 1)]) {
      const r = await handleAppRequest(req(target, '/film.mp4'), assetDeps());
      expect(r.status).toBe(200);
      expect(r.headers).toMatchObject({
        'Content-Type': 'video/mp4',
        'Content-Length': '1000',
        'Accept-Ranges': 'bytes',
        ETag: `"${'f'.repeat(64)}"`,
        'Last-Modified': UPDATED.toUTCString(),
        'X-Content-Type-Options': 'nosniff',
        'X-Drobek-App': 'shop',
      });
      expect(await bodyOf(r.body)).toEqual(FILM);
    }
    expect(opened.every((o) => o.appId === 'app_shop')).toBe(true);
  });

  it('Range → 206 with Content-Range; suffix and open-ended; unsatisfiable → 416', async () => {
    const r = await handleAppRequest(req(prod('shop'), '/film.mp4', { headers: { Range: 'bytes=0-99' } }), assetDeps());
    expect(r.status).toBe(206);
    expect(r.headers).toMatchObject({ 'Content-Range': 'bytes 0-99/1000', 'Content-Length': '100' });
    expect(await bodyOf(r.body)).toEqual(FILM.subarray(0, 100));
    const tail = await handleAppRequest(req(prod('shop'), '/film.mp4', { headers: { Range: 'bytes=-10' } }), assetDeps());
    expect(tail.headers['Content-Range']).toBe('bytes 990-999/1000');
    const open = await handleAppRequest(req(prod('shop'), '/film.mp4', { headers: { Range: 'bytes=900-' } }), assetDeps());
    expect(open.headers['Content-Length']).toBe('100');
    const bad = await handleAppRequest(req(prod('shop'), '/film.mp4', { headers: { Range: 'bytes=5000-' } }), assetDeps());
    expect(bad.status).toBe(416);
    expect(bad.headers['Content-Range']).toBe('bytes */1000');
    expect(bad.body).toBeNull();
  });

  it('HEAD sends headers only; If-None-Match / If-Modified-Since → 304; a stale If-Range → the whole file', async () => {
    const head = await handleAppRequest(req(prod('shop'), '/film.mp4', { method: 'HEAD' }), assetDeps());
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers['Content-Length']).toBe('1000');
    const inm = await handleAppRequest(
      req(prod('shop'), '/film.mp4', { headers: { 'If-None-Match': `"${'f'.repeat(64)}"` } }),
      assetDeps()
    );
    expect(inm.status).toBe(304);
    const ims = await handleAppRequest(
      req(prod('shop'), '/film.mp4', { headers: { 'If-Modified-Since': UPDATED.toUTCString() } }),
      assetDeps()
    );
    expect(ims.status).toBe(304);
    const stale = await handleAppRequest(
      req(prod('shop'), '/film.mp4', { headers: { Range: 'bytes=0-9', 'If-Range': '"old"' } }),
      assetDeps()
    );
    expect(stale.status).toBe(200);
    expect(opened.filter((o) => o.range === undefined)).toHaveLength(1);
  });

  it('caching: published hosts 5 minutes, preview / version revalidate, a password app private', async () => {
    expect((await handleAppRequest(req(prod('shop'), '/film.mp4'), assetDeps())).headers['Cache-Control']).toBe(
      'public, max-age=300, must-revalidate'
    );
    expect((await handleAppRequest(req(preview('shop'), '/film.mp4'), assetDeps())).headers['Cache-Control']).toBe(
      'public, max-age=0, must-revalidate'
    );
    const token = mintAppAccessToken('app_vault', SECRET);
    const vault = await handleAppRequest(
      req(prod('vault'), '/film.mp4', { headers: { Cookie: `${APP_ACCESS_COOKIE}=${token}` } }),
      assetDeps()
    );
    expect(vault.status).toBe(200);
    expect(vault.headers['Cache-Control']).toBe('private, max-age=300, must-revalidate');
  });

  it('SVG is an attachment with a second CSP sandbox', async () => {
    const r = await handleAppRequest(req(prod('shop'), '/img/logo.svg'), assetDeps());
    expect(r.headers['Content-Disposition']).toBe('attachment; filename="logo.svg"');
    expect(r.headers['Content-Security-Policy']).toBe(`${APP_CSP}, sandbox`);
  });

  it('takedown 451, password gate 401 and not-published 404 come first; unknown or invalid names are 404', async () => {
    model.get('shop')!.app.lockedReason = 'phishing';
    store.bust('shop');
    expect((await handleAppRequest(req(prod('shop'), '/film.mp4'), assetDeps())).status).toBe(451);
    expect((await handleAppRequest(req(preview('shop'), '/film.mp4'), assetDeps())).status).toBe(451);
    expect((await handleAppRequest(req(prod('vault'), '/film.mp4'), assetDeps())).status).toBe(401);
    expect((await handleAppRequest(req(prod('draft'), '/film.mp4'), assetDeps())).status).toBe(404);
    expect(opened).toEqual([]);
    for (const path of ['/missing.mp4', '/Film.mp4', '/img/a%2Fb.svg', '/page.html', '/gone.mp4', '/.hidden.mp4', '/img/../film.mp4']) {
      expect((await handleAppRequest(req(preview('draft'), path), assetDeps())).status, path).toBe(404);
    }
  });

  it("the app's own file at the same path wins; the SPA fallback never answers an asset path; without deps.assets it is a plain 404", async () => {
    model.get('shop')!.versions.get(1)!.files['img/logo.svg'] = { content: '<svg id="own"/>', kind: 'source' };
    store.bust('shop');
    const own = await handleAppRequest(req(prod('shop'), '/img/logo.svg'), assetDeps());
    expect(text(own.body)).toBe('<svg id="own"/>');
    expect((await handleAppRequest(req(prod('shop'), '/film.mp4'), deps)).status).toBe(404);
    // An extension-less path still falls back to index.html; nested asset paths resolve.
    expect(text((await handleAppRequest(req(prod('shop'), '/deep/link'), assetDeps())).body)).toContain('<h1>v1</h1>');
    expect((await handleAppRequest(req(prod('shop'), '/media/film.mp4'), assetDeps())).status).toBe(404);
  });

  it('NSO-362: production and custom hosts look assets up in the published version’s frozen set, preview in the draft, a version host in its set or the draft', async () => {
    const scopes: unknown[] = [];
    const d = assetDeps();
    const find = d.assets!.find;
    d.assets = { ...d.assets!, find: (appId, name, scope) => (scopes.push(scope), find(appId, name, scope)) };
    const custom: AppHostTarget = { kind: 'custom', slug: 'shop', hostname: 'shop.firma.cz' };
    for (const target of [prod('shop'), custom, preview('shop'), ver('shop', 2)]) {
      expect((await handleAppRequest(req(target, '/film.mp4'), d)).status).toBe(200);
    }
    expect(scopes).toEqual([{ versionId: 'v_1' }, { versionId: 'v_1' }, 'draft', { versionId: 'v_2', orDraft: true }]);
  });

  it('a Range header without "=" is not a range: the whole file (200), not 416 (RFC 9110)', async () => {
    const r = await handleAppRequest(req(prod('shop'), '/film.mp4', { headers: { Range: 'bytes' } }), assetDeps());
    expect(r.status).toBe(200);
    expect(r.headers['Content-Length']).toBe('1000');
  });
});
