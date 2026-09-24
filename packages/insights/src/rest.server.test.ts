/**
 * The beacon HTTP contract (PHY-123 → apps origin, M1-07) over the
 * framework-free handler: size cap BEFORE parsing (declared and counted),
 * same-origin only, POST only, JSON only, and the recorder is handed the app
 * the host resolved — never an app named by the client. The process-level
 * regression (a 9 KiB body over a real socket → 413, the server keeps
 * answering) lives in @drobek/serving node.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { InsightsError } from './errors.js';
import { BEACON_MAX_BYTES } from './limits.js';
import { BEACON_PATH, beaconSameOrigin, handleBeacon, type BeaconRecorder, type BeaconRequest } from './rest.server.js';

function beaconReq(body: string | Buffer | 'too_large', headers: Record<string, string> = {}, method = 'POST'): BeaconRequest & { reads: number[] } {
  const h = Object.fromEntries(Object.entries({ host: 'shop--preview.apps.localhost:3041', ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  const reads: number[] = [];
  return {
    method,
    header: (n) => h[n.toLowerCase()] ?? null,
    clientIp: '203.0.113.9',
    reads,
    readBody: async (limit) => {
      reads.push(limit);
      if (body === 'too_large') return 'too_large';
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      return buf.length > limit ? 'too_large' : buf;
    },
  };
}

function recorder() {
  const calls: Parameters<BeaconRecorder>[0][] = [];
  const record: BeaconRecorder = async (input) => {
    calls.push(input);
    return { stored: 1 };
  };
  return { calls, record };
}

const EVENT = JSON.stringify({ events: [{ type: 'error', message: 'boom', url: 'https://x/', ts: Date.now() }] });

describe('handleBeacon', () => {
  it('lives at /__drobek/v1/_beacon', () => {
    expect(BEACON_PATH).toBe('/__drobek/v1/_beacon');
  });

  it('stores a same-origin batch for the RESOLVED app and answers 204 no-store', async () => {
    const { calls, record } = recorder();
    const res = await handleBeacon(beaconReq(EVENT, { origin: 'http://shop--preview.apps.localhost:3041' }), 'app_1', { record });
    expect(res.status).toBe(204);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ appId: 'app_1', ip: '203.0.113.9' });
    expect((calls[0].batch as { events: unknown[] }).events).toHaveLength(1);
  });

  it('no resolved client IP → the recorder gets ip: null, never a shared "unknown" (NSO-328)', async () => {
    const { calls, record } = recorder();
    const req = { ...beaconReq(EVENT, { origin: 'http://shop--preview.apps.localhost:3041' }), clientIp: null };
    expect((await handleBeacon(req, 'app_1', { record })).status).toBe(204);
    expect(calls[0]).toMatchObject({ appId: 'app_1', ip: null });
  });

  it('9 KiB declared → 413 before a byte is read', async () => {
    const { calls, record } = recorder();
    const req = beaconReq('x'.repeat(9 * 1024), { 'content-length': String(9 * 1024) });
    const res = await handleBeacon(req, 'app_1', { record });
    expect(res.status).toBe(413);
    expect(req.reads).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('9 KiB chunked (no Content-Length) → the counted cap answers 413', async () => {
    const { calls, record } = recorder();
    const req = beaconReq(Buffer.alloc(9 * 1024, 0x78));
    const res = await handleBeacon(req, 'app_1', { record });
    expect(res.status).toBe(413);
    expect(req.reads).toEqual([BEACON_MAX_BYTES]);
    expect(calls).toHaveLength(0);
  });

  it('exactly 8 KiB is accepted by the cap (then parsed)', async () => {
    const { record } = recorder();
    const padded = JSON.stringify({ events: [], pad: 'x'.repeat(BEACON_MAX_BYTES - 22) });
    expect(Buffer.byteLength(padded)).toBe(BEACON_MAX_BYTES);
    expect((await handleBeacon(beaconReq(padded), 'app_1', { record })).status).toBe(204);
  });

  it('refuses cross-origin posts (foreign Origin, null Origin, cross-site fetch metadata)', async () => {
    const { calls, record } = recorder();
    const cases: Record<string, string>[] = [
      { origin: 'https://evil.example' },
      { origin: 'null' },
      { origin: 'http://other--preview.apps.localhost:3041' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
    ];
    for (const headers of cases) {
      expect((await handleBeacon(beaconReq(EVENT, headers), 'app_1', { record })).status, JSON.stringify(headers)).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it('405 for other methods, 400 for bad JSON or a failed stream', async () => {
    const { record } = recorder();
    const get = await handleBeacon(beaconReq('', {}, 'GET'), 'app_1', { record });
    expect(get.status).toBe(405);
    expect(get.headers.Allow).toBe('POST');
    expect((await handleBeacon(beaconReq('{nope'), 'app_1', { record })).status).toBe(400);
    const broken: BeaconRequest = { ...beaconReq(EVENT), readBody: async () => null };
    expect((await handleBeacon(broken, 'app_1', { record })).status).toBe(400);
  });

  it('maps recorder errors: rate_limited → 429, anything else → 500', async () => {
    const limited: BeaconRecorder = async () => {
      throw new InsightsError('rate_limited', 'slow down');
    };
    expect((await handleBeacon(beaconReq(EVENT), 'app_1', { record: limited })).status).toBe(429);
    const broken: BeaconRecorder = async () => {
      throw new Error('db down');
    };
    expect((await handleBeacon(beaconReq(EVENT), 'app_1', { record: broken })).status).toBe(500);
  });
});

describe('beaconSameOrigin', () => {
  it('no Origin (non-browser client) passes; the app host itself passes, case-insensitively', () => {
    expect(beaconSameOrigin(null, 'a.apps.x', null)).toBe(true);
    expect(beaconSameOrigin('https://A.apps.x', 'a.apps.x', 'same-origin')).toBe(true);
    expect(beaconSameOrigin('https://a.apps.x', 'a.apps.x.', null)).toBe(true);
    expect(beaconSameOrigin('https://a.apps.x:8443', 'a.apps.x:8443', null)).toBe(true);
  });
  it('anything else fails', () => {
    expect(beaconSameOrigin('https://b.apps.x', 'a.apps.x', null)).toBe(false);
    expect(beaconSameOrigin('https://a.apps.x', null, null)).toBe(false);
    expect(beaconSameOrigin('not a url', 'a.apps.x', null)).toBe(false);
    expect(beaconSameOrigin(null, 'a.apps.x', 'cross-site')).toBe(false);
  });
});
