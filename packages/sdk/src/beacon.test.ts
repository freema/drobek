import { describe, expect, it } from 'vitest';
import {
  BEACON_ENDPOINT,
  BEACON_FLUSH_MS,
  BEACON_MAX_BYTES,
  BEACON_MAX_PER_PAGE,
  VERSION_TIMING_METRIC,
  describeError,
  describeResource,
  describeViolation,
  installBeacon,
  packBatches,
  pageUrl,
  pageVersion,
  resourceAddress,
  type BeaconEnv,
  type BeaconEvent,
} from './beacon.js';

type Listener = (e: unknown) => void;
type Body = { version: number | null; load?: true; events: BeaconEvent[] };

function fakeWindow(opts: { sendBeacon?: boolean; href?: string; serverTiming?: { name: string; description: string }[] } = {}) {
  const listeners = new Map<string, Listener[]>();
  const capture = new Map<string, boolean>();
  const timers: { fn: () => void; ms: number }[] = [];
  const beacons: { url: string; data: Blob }[] = [];
  const fetches: { url: string; init: RequestInit }[] = [];
  const env: BeaconEnv = {
    addEventListener: (type, l, useCapture) => {
      listeners.set(type, [...(listeners.get(type) ?? []), l]);
      capture.set(type, useCapture === true);
    },
    location: { href: opts.href ?? 'https://shop--preview.apps.example/cart' },
    performance: {
      getEntriesByType: (type) => (type === 'navigation' ? [{ serverTiming: opts.serverTiming ?? [{ name: VERSION_TIMING_METRIC, description: '7' }] }] : []),
    },
    navigator: {
      userAgent: 'TestBrowser/1.0',
      ...(opts.sendBeacon === false
        ? {}
        : {
            sendBeacon: (url: string, data: Blob) => {
              beacons.push({ url, data });
              return true;
            },
          }),
    },
    fetch: async (url, init) => {
      fetches.push({ url, init });
      return {};
    },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    Date: { now: () => 1_790_000_000_000 },
  };
  const dispatch = (type: string, e: unknown) => {
    for (const l of listeners.get(type) ?? []) l(e);
  };
  const runTimers = () => {
    for (const t of timers.splice(0)) t.fn();
  };
  return { env, listeners, capture, timers, beacons, fetches, dispatch, runTimers };
}

async function bodies(beacons: { data: Blob }[]): Promise<Body[]> {
  return Promise.all(beacons.map(async (b) => JSON.parse(await b.data.text()) as Body));
}

describe('installBeacon', () => {
  it('registers error + unhandledrejection and POSTs them to the app beacon within the flush delay', async () => {
    const w = fakeWindow();
    const handle = installBeacon(w.env)!;
    expect(handle).not.toBeNull();
    expect([...w.listeners.keys()]).toEqual(expect.arrayContaining(['error', 'unhandledrejection', 'pagehide']));

    const err = new TypeError('Cannot read properties of undefined (reading "x") for ann@example.com');
    w.dispatch('error', { message: 'Uncaught TypeError: …', error: err, filename: 'https://x/main.js', lineno: 3, colno: 9 });
    w.dispatch('unhandledrejection', { reason: { code: 42 } });
    expect(handle.pending()).toBe(2);
    expect(w.timers).toHaveLength(1);
    expect(w.timers[0].ms).toBe(BEACON_FLUSH_MS);
    expect(BEACON_FLUSH_MS).toBeLessThan(5000);

    w.runTimers();
    expect(w.beacons).toHaveLength(1);
    expect(w.beacons[0].url).toBe(BEACON_ENDPOINT);
    expect(w.beacons[0].data.type).toBe('application/json');
    const [b] = await bodies(w.beacons);
    // The page load rides along with the first events, and the version the page was served from.
    expect(b).toMatchObject({ version: 7, load: true });
    expect(b.events).toHaveLength(2);
    expect(b.events[0]).toMatchObject({
      type: 'error',
      message: 'TypeError: Cannot read properties of undefined (reading "x") for ann@example.com',
      url: 'https://shop--preview.apps.example/cart',
      ua: 'TestBrowser/1.0',
      ts: 1_790_000_000_000,
    });
    expect(b.events[0].stack).toContain('TypeError');
    expect(b.events[1]).toMatchObject({ type: 'unhandledrejection', message: 'Unhandled rejection: {"code":42}', stack: null });
  });

  it('reports the page as origin + path: no query string, fragment or credentials leave the browser', async () => {
    const w = fakeWindow({ href: 'https://ann:pw@shop.apps.example/login/verify?code=123456&email=ann%40example.com#token=abc' });
    installBeacon(w.env);
    w.dispatch('error', { message: 'boom' });
    w.runTimers();
    const [b] = await bodies(w.beacons);
    expect(b.events[0].url).toBe('https://shop.apps.example/login/verify');
    expect(JSON.stringify(b)).not.toMatch(/123456|ann%40|token=|pw@/);
  });

  it('is idempotent per window', () => {
    const w = fakeWindow();
    expect(installBeacon(w.env)).not.toBeNull();
    expect(installBeacon(w.env)).toBeNull();
    expect(w.listeners.get('error')).toHaveLength(1);
  });

  it('caps repeats (3 per identical error) and the page total (100)', async () => {
    const w = fakeWindow();
    const handle = installBeacon(w.env)!;
    for (let i = 0; i < 10; i++) w.dispatch('error', { message: 'same' });
    expect(handle.pending()).toBe(3);
    for (let i = 0; i < 200; i++) w.dispatch('error', { message: `distinct ${i}` });
    expect(handle.pending()).toBe(BEACON_MAX_PER_PAGE);
    handle.flush();
    const all = (await bodies(w.beacons)).flatMap((b) => b.events);
    expect(all).toHaveLength(BEACON_MAX_PER_PAGE);
    for (const b of w.beacons) expect(b.data.size).toBeLessThanOrEqual(BEACON_MAX_BYTES);
  });

  it('flushes on pagehide; falls back to fetch keepalive without sendBeacon', () => {
    const w = fakeWindow({ sendBeacon: false });
    installBeacon(w.env);
    w.dispatch('error', { message: 'boom', filename: 'https://x/main.js', lineno: 1, colno: 2 });
    w.dispatch('pagehide', {});
    expect(w.fetches).toHaveLength(1);
    expect(w.fetches[0].url).toBe(BEACON_ENDPOINT);
    expect(w.fetches[0].init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'same-origin' });
    const sent = JSON.parse(String(w.fetches[0].init.body)) as Body;
    expect(sent.events[0].stack).toBe('    at https://x/main.js:1:2');
  });

  it('never throws out of the handler, even when sending fails', () => {
    const w = fakeWindow();
    w.env.navigator!.sendBeacon = () => {
      throw new Error('blocked');
    };
    w.env.fetch = () => {
      throw new Error('blocked too');
    };
    installBeacon(w.env);
    expect(() => w.dispatch('error', { message: 'x' })).not.toThrow();
    expect(() => w.runTimers()).not.toThrow();
  });
});

describe('the page load and the version', () => {
  it('reports the page load once, within the flush delay, with the version from Server-Timing — nothing about the visitor', async () => {
    const w = fakeWindow();
    const handle = installBeacon(w.env)!;
    expect(handle.pending()).toBe(0);
    expect(w.timers).toHaveLength(1);
    w.runTimers();
    expect(await bodies(w.beacons)).toEqual([{ version: 7, load: true, events: [] }]);

    // Later reports carry the version, never a second load.
    w.dispatch('error', { message: 'later' });
    w.runTimers();
    w.dispatch('pagehide', {});
    const later = (await bodies(w.beacons)).slice(1);
    expect(later).toHaveLength(1);
    expect(later[0]).toMatchObject({ version: 7, events: [{ type: 'error', message: 'later' }] });
    expect(later[0].load).toBeUndefined();
  });

  it('a page closed before the flush still reports its load on pagehide', async () => {
    const w = fakeWindow();
    installBeacon(w.env);
    w.dispatch('pagehide', {});
    expect(await bodies(w.beacons)).toEqual([{ version: 7, load: true, events: [] }]);
    w.runTimers();
    expect(w.beacons).toHaveLength(1);
  });

  it('no drobek-version server timing → version null (the server files it under the version its host serves)', async () => {
    const w = fakeWindow({ serverTiming: [{ name: 'cdn', description: 'hit' }] });
    installBeacon(w.env);
    w.runTimers();
    expect((await bodies(w.beacons))[0]).toEqual({ version: null, load: true, events: [] });
  });

  it('pageVersion reads only a positive integer description, and never throws', () => {
    const perf = (serverTiming: unknown) => ({ performance: { getEntriesByType: () => [{ serverTiming }] } });
    expect(pageVersion(perf([{ name: VERSION_TIMING_METRIC, description: '12' }]))).toBe(12);
    expect(pageVersion(perf([{ name: VERSION_TIMING_METRIC, description: 'v12' }]))).toBeNull();
    expect(pageVersion(perf([{ name: VERSION_TIMING_METRIC, description: '0' }]))).toBeNull();
    expect(pageVersion(perf(undefined))).toBeNull();
    expect(pageVersion({})).toBeNull();
    expect(
      pageVersion({
        performance: {
          getEntriesByType: () => {
            throw new Error('no timing');
          },
        },
      })
    ).toBeNull();
  });
});

describe('failed resource loads and CSP blocks', () => {
  it('listens for error in the capture phase: an element\'s failed load is a resource report, origin + path only', async () => {
    const w = fakeWindow();
    installBeacon(w.env);
    expect(w.capture.get('error')).toBe(true);
    w.dispatch('error', { target: { tagName: 'SCRIPT', src: 'https://shop--preview.apps.example/missing.js?token=abc#x' } });
    w.dispatch('error', { target: { tagName: 'LINK', rel: 'stylesheet', href: 'https://cdn.example/a.css?v=1' } });
    w.dispatch('error', { target: { tagName: 'IMG', currentSrc: '', src: 'data:image/png;base64,iVBORw0KGgo=' } });
    // The window's own error event stays an uncaught error.
    w.dispatch('error', { target: w.env, message: 'Uncaught boom' });
    w.runTimers();
    const [b] = await bodies(w.beacons);
    expect(b.events.map((e) => [e.type, e.message])).toEqual([
      ['resource', 'Failed to load script: https://shop--preview.apps.example/missing.js'],
      ['resource', 'Failed to load stylesheet: https://cdn.example/a.css'],
      ['resource', 'Failed to load image: data:'],
      ['error', 'Uncaught boom'],
    ]);
    expect(b.events[0]).toMatchObject({ stack: null, url: 'https://shop--preview.apps.example/cart' });
    expect(JSON.stringify(b)).not.toMatch(/token=|v=1|iVBOR/);
  });

  it('reports what the CSP blocked (enforced policies only), the source location without its query', async () => {
    const w = fakeWindow();
    installBeacon(w.env);
    w.dispatch('securitypolicyviolation', {
      blockedURI: 'https://evil.example/lib.js?k=secret',
      effectiveDirective: 'script-src-elem',
      violatedDirective: 'script-src',
      sourceFile: 'https://shop--preview.apps.example/main.js?v=abc',
      lineNumber: 3,
      columnNumber: 14,
      disposition: 'enforce',
    });
    w.dispatch('securitypolicyviolation', { blockedURI: 'inline', effectiveDirective: 'script-src-elem', disposition: 'enforce' });
    w.dispatch('securitypolicyviolation', { blockedURI: 'https://x.example/', effectiveDirective: 'img-src', disposition: 'report' });
    w.runTimers();
    const [b] = await bodies(w.beacons);
    expect(b.events).toHaveLength(2);
    expect(b.events[0]).toMatchObject({
      type: 'csp',
      message: 'Content-Security-Policy blocked https://evil.example/lib.js (script-src-elem)',
      stack: '    at https://shop--preview.apps.example/main.js:3:14',
    });
    expect(b.events[1]).toMatchObject({ type: 'csp', message: 'Content-Security-Policy blocked inline (script-src-elem)', stack: null });
    expect(JSON.stringify(b)).not.toMatch(/secret|v=abc/);
  });

  it('the same caps hold: 3 copies of one failed file, 100 reports per page', () => {
    const w = fakeWindow();
    const handle = installBeacon(w.env)!;
    for (let i = 0; i < 10; i++) w.dispatch('error', { target: { tagName: 'IMG', src: 'https://x.example/a.png' } });
    expect(handle.pending()).toBe(3);
    for (let i = 0; i < 200; i++) w.dispatch('securitypolicyviolation', { blockedURI: `https://x.example/${i}.js`, effectiveDirective: 'script-src' });
    expect(handle.pending()).toBe(BEACON_MAX_PER_PAGE);
  });

  it('describes odd elements and violations without throwing', () => {
    expect(describeResource({ tagName: 'VIDEO', src: 'https://x.example/m.mp4' }, 'u', null, 1).message).toBe('Failed to load video: https://x.example/m.mp4');
    expect(describeResource({ tagName: 'LINK', rel: 'preload', href: 'https://x.example/f.woff2' }, 'u', null, 1).message).toBe('Failed to load link: https://x.example/f.woff2');
    expect(describeResource({}, 'u', null, 1).message).toBe('Failed to load resource');
    expect(describeViolation({}, 'u', null, 1)!.message).toBe('Content-Security-Policy blocked a request (a directive)');
    expect(describeViolation({ disposition: 'report' }, 'u', null, 1)).toBeNull();
  });

  it('resourceAddress: http(s) as origin + path, other URLs by scheme, CSP keywords as they are', () => {
    expect(resourceAddress('https://a.example/x/y.js?q=1#f')).toBe('https://a.example/x/y.js');
    expect(resourceAddress('blob:https://a.example/123')).toBe('blob:');
    expect(resourceAddress('eval')).toBe('eval');
    expect(resourceAddress('wasm-eval')).toBe('wasm-eval');
    expect(resourceAddress('/relative?x')).toBe('');
    expect(resourceAddress(undefined)).toBe('');
  });
});

describe('packBatches', () => {
  const ev = (message: string, stack: string | null = null): BeaconEvent => ({ type: 'error', message, stack, url: 'https://x/', ua: null, ts: 1 });

  it('every body fits the server cap (≤ 20 events, ≤ 8 KiB)', () => {
    const events = Array.from({ length: 45 }, (_, i) => ev(`e${i}`, 'at f (main.js:1:1)\n'.repeat(100)));
    const out = packBatches(events);
    let total = 0;
    for (const b of out) {
      expect(new TextEncoder().encode(b).byteLength).toBeLessThanOrEqual(BEACON_MAX_BYTES);
      const n = (JSON.parse(b) as { events: unknown[] }).events.length;
      expect(n).toBeLessThanOrEqual(20);
      total += n;
    }
    expect(total).toBe(45);
  });

  it('an event too big on its own loses its stack', () => {
    const [b] = packBatches([ev('big', 'x'.repeat(20_000))]);
    expect((JSON.parse(b) as { events: BeaconEvent[] }).events[0]).toMatchObject({ message: 'big', stack: null });
  });

  it('every body carries the version; only the first says load', () => {
    const out = packBatches(Array.from({ length: 30 }, (_, i) => ev(`e${i}`)), { version: 3, load: true }).map((b) => JSON.parse(b) as Body);
    expect(out).toHaveLength(2);
    expect(out.map((b) => [b.version, b.load ?? false, b.events.length])).toEqual([
      [3, true, 20],
      [3, false, 10],
    ]);
    expect(packBatches([], { version: 3, load: true })).toEqual(['{"version":3,"load":true,"events":[]}']);
    expect(packBatches([], { version: 3 })).toEqual([]);
  });
});

describe('describeError', () => {
  it('uses the ErrorEvent message when no Error object is attached (cross-origin "Script error.")', () => {
    expect(describeError('error', { message: 'Script error.' }, 'u', null, 1)).toMatchObject({ message: 'Script error.', stack: null });
    expect(describeError('unhandledrejection', { reason: new Error('nope') }, 'u', null, 1).message).toBe('Error: nope');
    expect(describeError('error', {}, 'u', null, 1).message).toBe('(no message)');
  });
});

describe('pageUrl', () => {
  it('keeps origin + path of an http(s) page and drops query, fragment and credentials', () => {
    expect(pageUrl('https://shop--preview.apps.example/cart?code=123456#x')).toBe('https://shop--preview.apps.example/cart');
    expect(pageUrl('http://u:p@shop.apps.localhost:3041/a/b/?q=1')).toBe('http://shop.apps.localhost:3041/a/b/');
    expect(pageUrl('https://shop.apps.example')).toBe('https://shop.apps.example/');
  });

  it('cuts anything else at the first ? or #, and a non-string is empty', () => {
    expect(pageUrl('/relative/path?code=123456')).toBe('/relative/path');
    expect(pageUrl('about:blank#frag')).toBe('about:blank');
    expect(pageUrl(undefined)).toBe('');
    expect(pageUrl(42)).toBe('');
  });
});
