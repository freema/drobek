import { describe, expect, it } from 'vitest';
import {
  BEACON_ENDPOINT,
  BEACON_FLUSH_MS,
  BEACON_MAX_BYTES,
  BEACON_MAX_PER_PAGE,
  describeError,
  installBeacon,
  packBatches,
  pageUrl,
  type BeaconEnv,
  type BeaconEvent,
} from './beacon.js';

type Listener = (e: unknown) => void;

function fakeWindow(opts: { sendBeacon?: boolean; href?: string } = {}) {
  const listeners = new Map<string, Listener[]>();
  const timers: { fn: () => void; ms: number }[] = [];
  const beacons: { url: string; data: Blob }[] = [];
  const fetches: { url: string; init: RequestInit }[] = [];
  const env: BeaconEnv = {
    addEventListener: (type, l) => listeners.set(type, [...(listeners.get(type) ?? []), l]),
    location: { href: opts.href ?? 'https://shop--preview.apps.example/cart' },
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
  return { env, listeners, timers, beacons, fetches, dispatch, runTimers };
}

async function bodies(beacons: { data: Blob }[]): Promise<{ events: BeaconEvent[] }[]> {
  return Promise.all(beacons.map(async (b) => JSON.parse(await b.data.text()) as { events: BeaconEvent[] }));
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

  it('reports the page as origin + path: no query string, fragment or credentials leave the browser (NSO-327)', async () => {
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
    const sent = JSON.parse(String(w.fetches[0].init.body)) as { events: BeaconEvent[] };
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
