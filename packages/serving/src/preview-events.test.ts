/**
 * The preview host's event stream: the handler gates it like a page (the
 * password gate, the takedown) and serves it on the preview host only; the
 * hub enforces its slots (429), sends the heartbeat, ends a stream after its
 * lifetime and on the graceful stop, and turns app-changed events — from
 * this process and relayed from Redis — into typed messages.
 */
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_CHANGED_CHANNEL, emitLocalAppChanged, type AppHostTarget } from '@drobek/apps';
import { handleAppRequest, type AppRequest, type HandlerDeps } from './handler.js';
import { mintAppAccessToken, appAccessCookieName } from './password.js';
import {
  DEFAULT_PREVIEW_EVENTS_MAX_MS,
  DEFAULT_PREVIEW_EVENTS_MAX_PER_APP,
  DEFAULT_PREVIEW_EVENTS_MAX_PER_IP,
  PreviewEventsHub,
  previewEventLimitsFromEnv,
  previewEventsResponse,
  type VersionCompile,
} from './preview-events.server.js';
import { PREVIEW_EVENTS_PATH } from './preview-script.js';
import { ServeStore, type ServeApp, type ServeLoaders } from './store.server.js';
import { subscribeServeCache } from './subscriber.server.js';

const SECRET = 'k'.repeat(64);
let app: ServeApp;
let compiles: Map<number, VersionCompile>;
let hub: PreviewEventsHub;

const loaders: ServeLoaders = {
  async resolve(target: AppHostTarget) {
    if (target.slug !== 'shop') return { app: null, version: null };
    return { app, version: { id: 'v_3', number: 3 } };
  },
  async loadFiles() {
    return [];
  },
  async loadBlobs() {
    return new Map();
  },
  async loadPasswordHash() {
    return null;
  },
};

function newHub(limits = { maxPerApp: 3, maxPerIp: 2, maxMs: 60_000 }, heartbeatMs = 25_000): PreviewEventsHub {
  return new PreviewEventsHub({ compileOf: async (_appId, n) => compiles.get(n) ?? null, limits, heartbeatMs });
}

function deps(): HandlerDeps {
  return {
    store: new ServeStore({ loaders }),
    accessSecret: SECRET,
    secureCookies: false,
    allowUnlockAttempt: async () => true,
    previewEvents: (req, a, v) => previewEventsResponse(hub, req, a, v),
    platform: async () => ({ status: 404, headers: {}, body: 'platform' }),
  };
}

function req(target: AppHostTarget, opts: { ip?: string; cookie?: string; method?: string } = {}): AppRequest {
  const headers: Record<string, string> = opts.cookie ? { cookie: opts.cookie } : {};
  return {
    method: opts.method ?? 'GET',
    target,
    path: PREVIEW_EVENTS_PATH,
    query: '',
    header: (n) => headers[n.toLowerCase()] ?? null,
    readForm: async () => null,
    readBody: async () => null,
    clientIp: opts.ip ?? '203.0.113.9',
  };
}

/** Everything pushed into a stream so far (it is never read by a socket here). */
function drain(stream: Readable): string {
  let out = '';
  let chunk: unknown;
  while ((chunk = stream.read()) !== null) out += String(chunk);
  return out;
}

const messages = (text: string) =>
  text
    .split('\n\n')
    .filter((f) => f.startsWith('data: '))
    .map((f) => JSON.parse(f.slice('data: '.length)) as Record<string, unknown>);

const PREVIEW: AppHostTarget = { kind: 'preview', slug: 'shop' };

beforeEach(() => {
  app = { id: 'app_1', slug: 'shop', workspaceId: 'ws_1', visibility: 'public', frameAncestors: null };
  compiles = new Map([
    [4, { compiled: true, errors: 0 }],
    [5, { compiled: false, errors: 2 }],
  ]);
  hub = newHub();
});

afterEach(() => {
  hub.endAll();
  vi.useRealTimers();
});

describe('GET /__drobek/preview/events through the handler', () => {
  it('opens a text/event-stream on the preview host with the ready message', async () => {
    const r = await handleAppRequest(req(PREVIEW), deps());
    expect(r.status).toBe(200);
    expect(r.headers['Content-Type']).toBe('text/event-stream; charset=utf-8');
    expect(r.headers['X-Accel-Buffering']).toBe('no');
    expect(r.headers['Content-Security-Policy']).toBeTruthy();
    const text = drain(r.body as Readable);
    expect(text).toContain('retry: 2000');
    expect(messages(text)).toEqual([{ type: 'ready', version: 3 }]);
    expect(hub.open('app_1')).toBe(1);
  });

  it('a password app needs its access cookie (401 JSON without it)', async () => {
    app = { ...app, visibility: 'password' };
    const locked = await handleAppRequest(req(PREVIEW), deps());
    expect(locked.status).toBe(401);
    expect(JSON.parse(String(locked.body))).toMatchObject({ error: 'password_required' });
    expect(hub.open()).toBe(0);
    const cookie = `${appAccessCookieName(false)}=${mintAppAccessToken('app_1', SECRET)}`;
    expect((await handleAppRequest(req(PREVIEW, { cookie }), deps())).status).toBe(200);
  });

  it('a taken-down app answers 451; a missing app 404', async () => {
    app = { ...app, lockedReason: 'abuse' };
    expect((await handleAppRequest(req(PREVIEW), deps())).status).toBe(451);
    expect((await handleAppRequest(req({ kind: 'preview', slug: 'nope' }), deps())).status).toBe(404);
    expect(hub.open()).toBe(0);
  });

  it('only the preview host has it: version, production and custom hosts answer 404', async () => {
    const targets: AppHostTarget[] = [
      { kind: 'version', slug: 'shop', number: 3 },
      { kind: 'prod', slug: 'shop' },
      { kind: 'custom', slug: 'shop', hostname: 'shop.example.com' },
    ];
    for (const t of targets) expect((await handleAppRequest(req(t), deps())).status, t.kind).toBe(404);
    expect((await handleAppRequest(req(PREVIEW, { method: 'POST' }), deps())).status).toBe(404);
    expect(hub.open()).toBe(0);
  });

  it('past a slot limit: 429 limit_exceeded naming it', async () => {
    for (let i = 0; i < 2; i++) expect((await handleAppRequest(req(PREVIEW), deps())).status).toBe(200);
    const perIp = await handleAppRequest(req(PREVIEW), deps());
    expect(perIp.status).toBe(429);
    expect(JSON.parse(String(perIp.body))).toMatchObject({ error: 'limit_exceeded', details: { limit: 'PREVIEW_EVENTS_MAX_PER_IP', value: 2 } });
    expect((await handleAppRequest(req(PREVIEW, { ip: '198.51.100.1' }), deps())).status).toBe(200);
    const perApp = await handleAppRequest(req(PREVIEW, { ip: '198.51.100.2' }), deps());
    expect(perApp.status).toBe(429);
    expect(JSON.parse(String(perApp.body)).details.limit).toBe('PREVIEW_EVENTS_MAX_PER_APP');
  });
});

describe('the hub', () => {
  const open = (ip = '203.0.113.9') => {
    const r = hub.subscribe({ appId: 'app_1', clientIp: ip, current: 3 });
    if (!r.ok) throw new Error('no slot');
    drain(r.stream);
    return r.stream;
  };

  it('a stored version reaches every stream of the app as a typed message (in-process emitter)', async () => {
    const a = open();
    const b = open('198.51.100.1');
    const other = hub.subscribe({ appId: 'app_2', clientIp: null, current: null });
    emitLocalAppChanged({ app_id: 'app_1', slug: 'shop', version: 4 });
    emitLocalAppChanged({ app_id: 'app_1', slug: 'shop', version: 5, kind: 'version' });
    await vi.waitFor(() => expect(messages(drain(a))).toHaveLength(2), { timeout: 1000 });
    expect(messages(drain(b))).toEqual([
      { type: 'version', version: 4, compiled: true, errors: 0 },
      { type: 'version', version: 5, compiled: false, errors: 2 },
    ]);
    expect(other.ok && messages(drain(other.stream))).toEqual([{ type: 'ready', version: null }]);
  });

  it('publishes, settings changes, retention deletes and unknown versions send nothing', async () => {
    const a = open();
    emitLocalAppChanged({ app_id: 'app_1', slug: 'shop', version: 4, kind: 'publish' });
    emitLocalAppChanged({ app_id: 'app_1', slug: 'shop', kind: 'settings' });
    emitLocalAppChanged({ app_id: 'app_1', slug: 'shop', kind: 'version' });
    emitLocalAppChanged({ app_id: 'app_1', slug: 'shop', version: 99 });
    await new Promise((r) => setTimeout(r, 20));
    expect(drain(a)).toBe('');
  });

  it('a version stored by another process arrives through the Redis relay', async () => {
    class FakeSub extends EventEmitter {
      subscribe = vi.fn(async () => 1);
      quit = vi.fn(async () => 'OK');
      disconnect = vi.fn();
    }
    const sub = new FakeSub();
    const relay = subscribeServeCache(new ServeStore({ loaders }), { redis: { duplicate: () => sub } as unknown as Redis });
    const a = open();
    sub.emit('message', APP_CHANGED_CHANNEL, JSON.stringify({ app_id: 'app_1', slug: 'shop', version: 4 }));
    await vi.waitFor(() => expect(messages(drain(a))).toEqual([{ type: 'version', version: 4, compiled: true, errors: 0 }]), { timeout: 1000 });
    await relay.stop();
  });

  it('sends a heartbeat comment and ends a stream after its lifetime, freeing the slot', () => {
    vi.useFakeTimers();
    hub = newHub({ maxPerApp: 3, maxPerIp: 1, maxMs: 60_000 }, 25_000);
    const s = open();
    vi.advanceTimersByTime(25_000);
    expect(drain(s)).toBe(': ping\n\n');
    expect(hub.open('app_1')).toBe(1);
    vi.advanceTimersByTime(35_000);
    expect(hub.open('app_1')).toBe(0);
    expect(drain(s)).toBe(': ping\n\n');
    expect(hub.subscribe({ appId: 'app_1', clientIp: '203.0.113.9', current: 3 }).ok).toBe(true);
  });

  it('a client that leaves frees its slots', async () => {
    hub = newHub({ maxPerApp: 1, maxPerIp: 1, maxMs: 60_000 });
    const s = open();
    expect(hub.subscribe({ appId: 'app_1', clientIp: '198.51.100.1', current: 3 }).ok).toBe(false);
    s.destroy();
    await new Promise((r) => setImmediate(r));
    expect(hub.open()).toBe(0);
    expect(hub.subscribe({ appId: 'app_1', clientIp: '198.51.100.1', current: 3 }).ok).toBe(true);
  });

  it('the graceful stop ends every stream and refuses new ones', () => {
    const s = open();
    hub.endAll();
    expect(hub.open()).toBe(0);
    expect(s.readableEnded || s.read() === null).toBe(true);
    expect(hub.subscribe({ appId: 'app_1', clientIp: null, current: 3 })).toEqual({ ok: false, reason: 'ending' });
  });
});

describe('PREVIEW_EVENTS_* limits', () => {
  it('defaults, overrides, and the default for anything but a positive integer', () => {
    expect(previewEventLimitsFromEnv({})).toEqual({
      maxPerApp: DEFAULT_PREVIEW_EVENTS_MAX_PER_APP,
      maxPerIp: DEFAULT_PREVIEW_EVENTS_MAX_PER_IP,
      maxMs: DEFAULT_PREVIEW_EVENTS_MAX_MS,
    });
    expect([DEFAULT_PREVIEW_EVENTS_MAX_PER_APP, DEFAULT_PREVIEW_EVENTS_MAX_PER_IP, DEFAULT_PREVIEW_EVENTS_MAX_MS]).toEqual([50, 4, 3_600_000]);
    expect(
      previewEventLimitsFromEnv({ PREVIEW_EVENTS_MAX_PER_APP: '10', PREVIEW_EVENTS_MAX_PER_IP: '0', PREVIEW_EVENTS_MAX_MS: 'x' })
    ).toEqual({ maxPerApp: 10, maxPerIp: 4, maxMs: 3_600_000 });
  });
});
