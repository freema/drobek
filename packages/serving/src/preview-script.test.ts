/**
 * The preview script: its tag goes into HTML pages of the preview host only
 * (never a version host for the reload, never the production host or a
 * custom domain), `"reload": false` keeps it out, `/__drobek/preview.js` is
 * served only on the preview and version hosts, and every other preview path
 * answers 404 without reaching the platform.
 */
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppHostTarget } from '@drobek/apps';
import { feedbackWidget } from './feedback-widget.js';
import { handleAppRequest, type AppRequest, type HandlerDeps } from './handler.js';
import type { StoredFile } from './manifest.js';
import { PREVIEW_EVENTS_PATH, PREVIEW_SCRIPT_PATH, previewScript, previewScriptTag } from './preview-script.js';
import { ServeStore, type ServeLoaders } from './store.server.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const INDEX = '<!doctype html><html><body><h1>Hi</h1></body></html>';

type Files = Record<string, { content: string; kind: 'source' | 'built' }>;
let versions: Map<number, { id: string; files: Files }>;
let platformCalls: number;
let signals: string[];

function filesWith(config: string): Files {
  return {
    'index.html': { content: INDEX, kind: 'source' },
    'drobek.json': { content: config, kind: 'source' },
    'main.js': { content: 'console.log(1)', kind: 'built' },
  };
}

let previewVersion = 2;
const loaders: ServeLoaders = {
  async resolve(target: AppHostTarget) {
    const app = { id: 'app_1', slug: 'shop', workspaceId: 'ws_1', visibility: 'public' as const, frameAncestors: null };
    if (target.slug !== 'shop') return { app: null, version: null };
    const n = target.kind === 'version' ? target.number : target.kind === 'preview' ? previewVersion : 1;
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

const script = previewScript();
const widget = feedbackWidget('https://dash.drobek.test')!;
let deps: HandlerDeps;

beforeEach(() => {
  previewVersion = 2;
  versions = new Map([
    [1, { id: 'v_1', files: filesWith('{}') }],
    [2, { id: 'v_2', files: filesWith('{}') }],
    [3, { id: 'v_3', files: filesWith('{"reload": false}') }],
  ]);
  platformCalls = 0;
  signals = [];
  deps = {
    store: new ServeStore({ loaders }),
    accessSecret: null,
    allowUnlockAttempt: async () => true,
    preview: script,
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
const TAG = (n: number) => `<script src="/__drobek/preview.js" defer data-app="shop" data-version="${n}" data-reload></script>`;
const PREVIEW: AppHostTarget = { kind: 'preview', slug: 'shop' };

describe('the preview script tag in served HTML', () => {
  it('the preview host gets it before </body>, with the version it serves; the ETag names it', async () => {
    const r = await handleAppRequest(req(PREVIEW), deps);
    expect(text(r.body)).toContain(`${TAG(2)}</body>`);
    expect(r.headers['Content-Length']).toBe(String(Buffer.byteLength(text(r.body))));
    expect(r.headers.ETag).toBe(`"${sha(INDEX)}-pv2r-${script.hash}"`);
    const again = await handleAppRequest(req(PREVIEW, '/', { 'if-none-match': String(r.headers.ETag) }), deps);
    expect(again.status).toBe(304);
  });

  it('a version host, the production host and a custom domain never get it', async () => {
    const targets: AppHostTarget[] = [
      { kind: 'version', slug: 'shop', number: 1 },
      { kind: 'prod', slug: 'shop' },
      { kind: 'custom', slug: 'shop', hostname: 'shop.example.com' },
    ];
    for (const target of targets) {
      const r = await handleAppRequest(req(target), deps);
      expect(r.status, target.kind).toBe(200);
      expect(text(r.body), target.kind).toBe(INDEX);
      expect(r.headers.ETag, target.kind).toBe(`"${sha(INDEX)}"`);
    }
  });

  it('"reload": false in the version\'s drobek.json keeps it out', async () => {
    previewVersion = 3;
    const r = await handleAppRequest(req(PREVIEW), deps);
    expect(text(r.body)).toBe(INDEX);
    expect(r.headers.ETag).toBe(`"${sha(INDEX)}"`);
  });

  it('never a non-HTML file; without the script in the deps nothing changes', async () => {
    expect(text((await handleAppRequest(req(PREVIEW, '/main.js'), deps)).body)).toBe('console.log(1)');
    expect(text((await handleAppRequest(req(PREVIEW), { ...deps, preview: null })).body)).toBe(INDEX);
  });

  it('goes before the feedback tag, which stays right before </body>', async () => {
    const r = await handleAppRequest(req(PREVIEW), { ...deps, feedback: widget });
    expect(text(r.body)).toContain(`${TAG(2)}<script src="/__drobek/feedback.js" defer data-app="shop" data-version="2"></script></body>`);
    expect(r.headers.ETag).toBe(`"${sha(INDEX)}-fb2-${widget.hash}-pv2r-${script.hash}"`);
  });

  it('carries only the slug characters and the version number; no part on → no tag', () => {
    expect(previewScriptTag('shop"><x', 4.7, { reload: true })).toBe(
      '<script src="/__drobek/preview.js" defer data-app="shopx" data-version="4" data-reload></script>'
    );
    expect(previewScriptTag('shop', 4, { reload: false })).toBeNull();
  });
});

describe('GET /__drobek/preview.js', () => {
  it('serves the script on the preview and version hosts, not counted as a request', async () => {
    for (const target of [PREVIEW, { kind: 'version', slug: 'shop', number: 1 }] as AppHostTarget[]) {
      const r = await handleAppRequest(req(target, PREVIEW_SCRIPT_PATH), deps);
      expect(r.status).toBe(200);
      expect(r.headers['Content-Type']).toBe('text/javascript; charset=utf-8');
      expect(r.headers['Content-Security-Policy']).toBeTruthy();
      const again = await handleAppRequest(req(target, PREVIEW_SCRIPT_PATH, { 'if-none-match': String(r.headers.ETag) }), deps);
      expect(again.status).toBe(304);
    }
    expect(signals).toEqual([]);
    expect(platformCalls).toBe(0);
  });

  it('the production host and a custom domain answer 404 and never reach the platform', async () => {
    for (const target of [{ kind: 'prod', slug: 'shop' }, { kind: 'custom', slug: 'shop', hostname: 'shop.example.com' }] as AppHostTarget[]) {
      for (const path of [PREVIEW_SCRIPT_PATH, PREVIEW_EVENTS_PATH]) {
        const r = await handleAppRequest(req(target, path), deps);
        expect(r.status, `${target.kind} ${path}`).toBe(404);
        expect(r.headers['Content-Type']).toBe('application/json; charset=utf-8');
      }
    }
    expect(platformCalls).toBe(0);
  });
});

describe('the script', () => {
  const js = script.script.toString();

  it('listens on its own origin, never in a frame, and reads no cookie', () => {
    expect(js).toContain(`new EventSource(EVENTS)`);
    expect(js).toContain(JSON.stringify(PREVIEW_EVENTS_PATH));
    expect(js).toContain('window.top !== window.self');
    expect(js).not.toMatch(/document\.cookie|localStorage|eval\(|new Function/);
  });

  it('dispatches on the message type; reloads only after a newer compiled version, else shows the notice', () => {
    expect(js).toContain("typeof m.type !== 'string'");
    expect(js).toContain('location.reload()');
    expect(js).toContain("'compile-failed'");
    expect(js).toContain('did not compile');
    expect(js).toContain('prefers-reduced-motion');
    expect(js).toContain("mode: 'closed'");
  });

  it('is valid JavaScript', () => {
    expect(() => new Function(js)).not.toThrow();
  });
});

/** The script run against a minimal stand-in of the page (attributes of its tag, EventSource, storage). */
function runScript(attrs: Record<string, string>, opts: { framed?: boolean; storage?: Map<string, string> } = {}) {
  const sources: { url: string; onmessage: ((e: { data: string }) => void) | null }[] = [];
  const storage = opts.storage ?? new Map<string, string>();
  const host = {
    attrs: new Map<string, string>(),
    style: { cssText: '' },
    setAttribute(n: string, v: string) {
      this.attrs.set(n, v);
    },
    removeAttribute(n: string) {
      this.attrs.delete(n);
    },
    attachShadow: () => root,
  };
  const toast = { textContent: '', className: 'toast' };
  const root = { innerHTML: '', querySelector: () => toast };
  const appended: unknown[] = [];
  const reload = vi.fn();
  const scrollTo = vi.fn();
  const win: Record<string, unknown> = {
    document: {
      currentScript: { getAttribute: (n: string) => attrs[n] ?? null, hasAttribute: (n: string) => n in attrs },
      createElement: () => host,
      body: { appendChild: (el: unknown) => appended.push(el) },
      readyState: 'complete',
    },
    EventSource: class {
      onmessage: ((e: { data: string }) => void) | null = null;
      constructor(public url: string) {
        sources.push(this);
      }
    },
    location: { pathname: '/list', search: '?page=2', reload },
    sessionStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
    scrollX: 0,
    scrollY: 640,
    scrollTo,
    setTimeout: () => 0,
  };
  win.window = win;
  win.self = win;
  win.top = opts.framed ? {} : win;
  runInNewContext(script.script.toString(), win);
  const send = (m: unknown) => sources[0]?.onmessage?.({ data: JSON.stringify(m) });
  return { sources, send, reload, scrollTo, storage, host, toast, appended };
}

describe('the script in a page', () => {
  const RELOAD = { 'data-app': 'shop', 'data-version': '4', 'data-reload': '' };

  it('reloads after a newer version that compiled, keeping the scroll position', () => {
    const page = runScript(RELOAD);
    expect(page.sources.map((s) => s.url)).toEqual([PREVIEW_EVENTS_PATH]);
    page.send({ type: 'ready', version: 4 });
    page.send({ type: 'version', version: 4, compiled: true, errors: 0 });
    expect(page.reload).not.toHaveBeenCalled();
    page.send({ type: 'version', version: 5, compiled: true, errors: 0 });
    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(page.storage.get('drobek:preview-scroll')!)).toEqual({ path: '/list?page=2', x: 0, y: 640 });
  });

  it('a newer version that did not compile shows the notice and does not reload', () => {
    const page = runScript(RELOAD);
    page.send({ type: 'version', version: 5, compiled: false, errors: 2 });
    expect(page.reload).not.toHaveBeenCalled();
    expect(page.host.attrs.get('data-notice')).toBe('compile-failed');
    expect(page.toast.textContent).toBe('Version 5 did not compile — your agent has the errors.');
    expect(page.toast.className).toBe('toast on');
  });

  it('a stream that opens behind a newer compiled version reloads; unknown and malformed messages are ignored', () => {
    const page = runScript(RELOAD);
    page.sources[0].onmessage?.({ data: 'not json' });
    page.send({ type: 'screenshot_requested' });
    page.send({ version: 9, compiled: true });
    expect(page.reload).not.toHaveBeenCalled();
    page.send({ type: 'ready', version: 6 });
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it('the reloaded page scrolls back to where it was (same path only)', () => {
    const storage = new Map([['drobek:preview-scroll', JSON.stringify({ path: '/list?page=2', x: 0, y: 640 })]]);
    const page = runScript(RELOAD, { storage });
    expect(page.scrollTo).toHaveBeenCalledWith(0, 640);
    expect(storage.has('drobek:preview-scroll')).toBe(false);
    const elsewhere = runScript(RELOAD, { storage: new Map([['drobek:preview-scroll', JSON.stringify({ path: '/other', x: 0, y: 9 })]]) });
    expect(elsewhere.scrollTo).not.toHaveBeenCalled();
  });

  it('does nothing in a frame or without data-reload', () => {
    expect(runScript(RELOAD, { framed: true }).sources).toHaveLength(0);
    expect(runScript({ 'data-app': 'shop', 'data-version': '4' }).sources).toHaveLength(0);
  });
});
