/**
 * The preview's feedback widget: the script tag goes into HTML pages of the
 * preview and version hosts only (never the production host or a custom
 * domain, never a non-HTML file), a drobek.json `"feedback": false` keeps it
 * out, `/__drobek/feedback.js` is served only where the tag can appear, and
 * the script opens the dashboard's /feedback/new without a credential.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppHostTarget } from '@drobek/apps';
import { FEEDBACK_SCRIPT_PATH, feedbackScriptTag, feedbackWidget, injectBeforeBodyEnd } from './feedback-widget.js';
import { handleAppRequest, type AppRequest, type HandlerDeps } from './handler.js';
import type { StoredFile } from './manifest.js';
import { ServeStore, type ServeLoaders } from './store.server.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const INDEX = '<!doctype html><html><body><h1>Hi</h1><script type="module" src="/main.js"></script></BODY></html>';

type Files = Record<string, { content: string; kind: 'source' | 'built' }>;
let versions: Map<number, { id: string; files: Files }>;
let platformCalls: number;
let signals: string[];

function filesWith(config: string): Files {
  return {
    'index.html': { content: INDEX, kind: 'source' },
    'about.html': { content: '<p>no body tag', kind: 'source' },
    'drobek.json': { content: config, kind: 'source' },
    'main.js': { content: 'console.log(1)', kind: 'built' },
  };
}

const loaders: ServeLoaders = {
  async resolve(target: AppHostTarget) {
    const app = { id: 'app_1', slug: 'shop', workspaceId: 'ws_1', visibility: 'public' as const, frameAncestors: null };
    if (target.slug !== 'shop') return { app: null, version: null };
    const n = target.kind === 'version' ? target.number : target.kind === 'preview' ? 2 : 1;
    const v = versions.get(n);
    return { app, version: v ? { id: v.id, number: n } : null };
  },
  async loadFiles(versionId) {
    const v = [...versions.values()].find((x) => x.id === versionId);
    return Object.entries(v?.files ?? {}).map(([path, f]): StoredFile => ({ path, kind: f.kind, sha256: sha(f.content), size: f.content.length }));
  },
  async loadBlobs(shas) {
    const out = new Map<string, Buffer>();
    for (const v of versions.values()) for (const f of Object.values(v.files)) if (shas.includes(sha(f.content))) out.set(sha(f.content), Buffer.from(f.content));
    return out;
  },
  async loadPasswordHash() {
    return null;
  },
};

let deps: HandlerDeps;
const widget = feedbackWidget('https://dash.drobek.test/ignored/path')!;

beforeEach(() => {
  versions = new Map([
    [1, { id: 'v_1', files: filesWith('{}') }],
    [2, { id: 'v_2', files: filesWith('{}') }],
    [3, { id: 'v_3', files: filesWith('{"feedback": false}') }],
  ]);
  platformCalls = 0;
  signals = [];
  deps = {
    store: new ServeStore({ loaders }),
    accessSecret: null,
    allowUnlockAttempt: async () => true,
    feedback: widget,
    signal: (_id, kind) => signals.push(kind),
    platform: async () => {
      platformCalls++;
      return { status: 404, headers: {}, body: 'platform' };
    },
  };
});

function req(target: AppHostTarget, path = '/', headers: Record<string, string> = {}, method = 'GET'): AppRequest {
  return {
    method,
    target,
    path,
    query: '',
    header: (n) => headers[n.toLowerCase()] ?? null,
    readForm: async () => null,
    readBody: async () => null,
    clientIp: '203.0.113.9',
  };
}

const text = (b: unknown) => (b === null ? '' : String(b));
const TAG = (n: number) => `<script src="/__drobek/feedback.js" defer data-app="shop" data-version="${n}"></script>`;

describe('the widget tag in served HTML', () => {
  it('the preview and a version host get it before </body>, with the version they serve', async () => {
    const preview = await handleAppRequest(req({ kind: 'preview', slug: 'shop' }), deps);
    expect(text(preview.body)).toContain(`${TAG(2)}</BODY>`);
    expect(preview.headers['Content-Length']).toBe(String(Buffer.byteLength(text(preview.body))));
    const v1 = await handleAppRequest(req({ kind: 'version', slug: 'shop', number: 1 }), deps);
    expect(text(v1.body)).toContain(TAG(1));
  });

  it('a page without </body> gets it at the end; a non-HTML file never', async () => {
    expect(text((await handleAppRequest(req({ kind: 'preview', slug: 'shop' }, '/about.html'), deps)).body)).toBe(`<p>no body tag${TAG(2)}`);
    expect(text((await handleAppRequest(req({ kind: 'preview', slug: 'shop' }, '/main.js'), deps)).body)).toBe('console.log(1)');
  });

  it('the production host and a custom domain never get it', async () => {
    for (const target of [{ kind: 'prod', slug: 'shop' }, { kind: 'custom', slug: 'shop', hostname: 'shop.example.com' }] as AppHostTarget[]) {
      const r = await handleAppRequest(req(target), deps);
      expect(r.status, target.kind).toBe(200);
      expect(text(r.body), target.kind).toBe(INDEX);
      expect(r.headers.ETag, target.kind).toBe(`"${sha(INDEX)}"`);
    }
  });

  it('"feedback": false in the version\'s drobek.json keeps it out', async () => {
    const r = await handleAppRequest(req({ kind: 'version', slug: 'shop', number: 3 }), deps);
    expect(text(r.body)).toBe(INDEX);
    expect(r.headers.ETag).toBe(`"${sha(INDEX)}"`);
  });

  it('without the widget in the deps nothing changes', async () => {
    const r = await handleAppRequest(req({ kind: 'preview', slug: 'shop' }), { ...deps, feedback: null });
    expect(text(r.body)).toBe(INDEX);
  });

  it('the ETag names the version and the widget, and revalidates', async () => {
    const r = await handleAppRequest(req({ kind: 'preview', slug: 'shop' }), deps);
    const etag = String(r.headers.ETag);
    expect(etag).toBe(`"${sha(INDEX)}-fb2-${widget.hash}"`);
    const again = await handleAppRequest(req({ kind: 'preview', slug: 'shop' }, '/', { 'if-none-match': etag }), deps);
    expect(again.status).toBe(304);
  });
});

describe('GET /__drobek/feedback.js', () => {
  it('serves the widget on the preview and version hosts, not counted as a request', async () => {
    for (const target of [{ kind: 'preview', slug: 'shop' }, { kind: 'version', slug: 'shop', number: 1 }] as AppHostTarget[]) {
      const r = await handleAppRequest(req(target, FEEDBACK_SCRIPT_PATH), deps);
      expect(r.status).toBe(200);
      expect(r.headers['Content-Type']).toBe('text/javascript; charset=utf-8');
      expect(r.headers['Content-Security-Policy']).toBeTruthy();
      expect(text(r.body)).toContain('"https://dash.drobek.test"');
      const again = await handleAppRequest(req(target, FEEDBACK_SCRIPT_PATH, { 'if-none-match': String(r.headers.ETag) }), deps);
      expect(again.status).toBe(304);
    }
    expect(signals).toEqual([]);
    expect(platformCalls).toBe(0);
  });

  it('the production host leaves the path to the platform (no widget there)', async () => {
    const r = await handleAppRequest(req({ kind: 'prod', slug: 'shop' }, FEEDBACK_SCRIPT_PATH), deps);
    expect(text(r.body)).toBe('platform');
    expect(platformCalls).toBe(1);
  });
});

describe('the widget script', () => {
  it('opens the dashboard page in a new window without an opener and never sends a note itself', () => {
    const js = widget.script.toString();
    expect(js).toContain("DASHBOARD + '/feedback/new?'");
    expect(js).toContain('noopener');
    expect(js).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|document\.cookie|localStorage/);
    expect(js).toContain('window.top !== window.self');
  });

  it('needs an http(s) dashboard origin', () => {
    expect(feedbackWidget(null)).toBeNull();
    expect(feedbackWidget('javascript:alert(1)')).toBeNull();
    expect(feedbackWidget('not a url')).toBeNull();
  });

  it('the tag carries only the slug characters and the version number', () => {
    expect(feedbackScriptTag('shop"><x', 4.7)).toBe('<script src="/__drobek/feedback.js" defer data-app="shopx" data-version="4"></script>');
    expect(injectBeforeBodyEnd(Buffer.from('<body>a</body><body>b</body>'), '<i>').toString()).toBe('<body>a</body><body>b<i></body>');
    expect(injectBeforeBodyEnd(Buffer.from('<html>x</html>'), '<i>').toString()).toBe('<html>x<i></html>');
  });
});
