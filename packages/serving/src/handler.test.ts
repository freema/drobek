/**
 * The app-host handler against an in-memory model of apps/versions/blobs
 * (the real ServeStore caching logic, fake loaders). The DB queries behind the
 * loaders are covered by store.test.ts (PGlite).
 */
import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppHostTarget } from '@drobek/apps';
import { APP_CSP, appCsp } from './csp.js';
import { handleAppRequest, type AppRequest, type HandlerDeps } from './handler.js';
import type { StoredFile } from './manifest.js';
import { UNLOCK_PATH } from './pages.js';
import { APP_ACCESS_COOKIE, hashAppPassword, mintAppAccessToken } from './password.js';
import { ServeStore, type ServeApp, type ServeLoaders } from './store.server.js';

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
    if (target.kind === 'prod') n = a.published;
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
        app: { id: 'app_shop', slug: 'shop', visibility: 'public', frameAncestors: null },
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
        app: { id: 'app_draft', slug: 'draft', visibility: 'public', frameAncestors: null },
        published: null,
        versions: new Map([[1, version('d_1', true, INDEX_V1)]]),
        passwordHash: null,
      },
    ],
    [
      'vault',
      {
        app: { id: 'app_vault', slug: 'vault', visibility: 'password', frameAncestors: null },
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
  opts: { method?: string; query?: string; headers?: Record<string, string>; form?: Record<string, string> } = {}
): AppRequest {
  const headers = Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method: opts.method ?? 'GET',
    target,
    path,
    query: opts.query ?? '',
    header: (n) => headers[n.toLowerCase()] ?? null,
    readForm: async () => (opts.form ? new URLSearchParams(opts.form) : null),
    clientIp: '203.0.113.9',
  };
}

const prod = (slug: string): AppHostTarget => ({ kind: 'prod', slug });
const preview = (slug: string): AppHostTarget => ({ kind: 'preview', slug });
const ver = (slug: string, number: number): AppHostTarget => ({ kind: 'version', slug, number });
const text = (b: Buffer | string | null) => (b === null ? '' : b.toString());

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
    expect(r404.headers).toEqual({ ...PREVIEW_SECURITY, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
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
