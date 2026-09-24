import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { FakeRedis } from '@drobek/auth';
import {
  CORE_LIMITS,
  LIMITS_SIGNATURE_HEADER,
  LIMITS_TIMESTAMP_HEADER,
  createLimitsProvider,
  limitsProviderConfigError,
  signLimitsRequest,
} from './limits.js';

const catalogue = [
  { env: 'HELLO_WAVES_PER_MINUTE', default: 30, meaning: 'waves' },
  { env: 'FORMS_PER_DAY', default: 100, meaning: 'forms' },
];
const SECRET = 'x'.repeat(40);
const env = { LIMITS_PROVIDER_URL: 'https://plans.example/api/', LIMITS_PROVIDER_SECRET: SECRET, FORMS_PER_DAY: '50' };

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('limits provider', () => {
  it('without LIMITS_PROVIDER_URL: env values, else module defaults', async () => {
    const fetch = vi.fn();
    const p = createLimitsProvider({ catalogue, env: { FORMS_PER_DAY: '7', HELLO_WAVES_PER_MINUTE: 'abc' }, fetch });
    expect(await p.forWorkspace('ws1')).toEqual({ HELLO_WAVES_PER_MINUTE: 30, FORMS_PER_DAY: 7 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a provider answering a LOWER limit wins; the request is HMAC-signed; the answer is cached 60 s', async () => {
    const redis = new FakeRedis();
    const now = () => 1_790_000_000_000;
    const fetch = vi.fn(async (_url: string, _init: { headers: Record<string, string> }) => ({
      ok: true,
      status: 200,
      json: async () => ({ limits: { HELLO_WAVES_PER_MINUTE: 1, UNKNOWN: 5, FORMS_PER_DAY: -1 } }),
    }));
    const p = createLimitsProvider({ catalogue, env, redis: () => redis as never, fetch, now });
    expect(await p.forWorkspace('ws 1')).toEqual({ HELLO_WAVES_PER_MINUTE: 1, FORMS_PER_DAY: 50 });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://plans.example/api/limits/ws%201');
    const ts = Number(init.headers[LIMITS_TIMESTAMP_HEADER]);
    expect(ts).toBe(1_790_000_000);
    expect(init.headers[LIMITS_SIGNATURE_HEADER]).toBe(signLimitsRequest(SECRET, ts, '/limits/ws%201'));
    expect(await redis.ttl('drobek:limits:ws 1')).toBe(60);
    // second call is served from the cache
    expect(await p.forWorkspace('ws 1')).toEqual({ HELLO_WAVES_PER_MINUTE: 1, FORMS_PER_DAY: 50 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('provider down → env fallback + a warning, then a short backoff', async () => {
    let t = 1_000_000;
    const log = logger();
    const fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const p = createLimitsProvider({ catalogue, env, fetch, log, now: () => t });
    expect(await p.forWorkspace('ws1')).toEqual({ HELLO_WAVES_PER_MINUTE: 30, FORMS_PER_DAY: 50 });
    expect(log.warn).toHaveBeenCalledWith(
      'limits provider unavailable — using the env defaults',
      expect.objectContaining({ workspace_id: 'ws1', error: 'ECONNREFUSED' })
    );
    await p.forWorkspace('ws1');
    expect(fetch).toHaveBeenCalledTimes(1); // backoff
    t += 11_000;
    await p.forWorkspace('ws1');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a non-2xx or malformed answer also falls back', async () => {
    const log = logger();
    const bad = createLimitsProvider({
      catalogue,
      env,
      log,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) }),
    });
    expect(await bad.forWorkspace('ws1')).toEqual({ HELLO_WAVES_PER_MINUTE: 30, FORMS_PER_DAY: 50 });
    const down = createLimitsProvider({ catalogue, env, log, fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
    expect(await down.forWorkspace('ws1')).toEqual({ HELLO_WAVES_PER_MINUTE: 30, FORMS_PER_DAY: 50 });
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('refuses to start with a URL and a weak secret', () => {
    expect(limitsProviderConfigError({})).toBeNull();
    expect(limitsProviderConfigError({ LIMITS_PROVIDER_URL: 'ftp://x' })).toMatch(/http\(s\) URL/);
    expect(limitsProviderConfigError({ LIMITS_PROVIDER_URL: 'https://x', LIMITS_PROVIDER_SECRET: 'short' })).toMatch(/at least 32/);
    expect(limitsProviderConfigError({ LIMITS_PROVIDER_URL: 'https://x', LIMITS_PROVIDER_SECRET: SECRET })).toBeNull();
  });
});

describe('core limits (NSO-329)', () => {
  const core = [...CORE_LIMITS, ...catalogue];
  const provider = (limits: Record<string, unknown>) =>
    createLimitsProvider({ catalogue: core, env, fetch: async () => ({ ok: true, status: 200, json: async () => ({ limits }) }) });

  it('APPS_MAX_PER_WORKSPACE (50) and DOMAINS_MAX_PER_APP (3) are in the catalogue with their defaults', () => {
    const p = createLimitsProvider({ catalogue: core, env: {} });
    expect(p.defaults()).toMatchObject({ APPS_MAX_PER_WORKSPACE: 50, DOMAINS_MAX_PER_APP: 3 });
  });

  it('the provider sets both per workspace; 0 is valid for DOMAINS_MAX_PER_APP only', async () => {
    expect(await provider({ APPS_MAX_PER_WORKSPACE: 2, DOMAINS_MAX_PER_APP: 0 }).forWorkspace('free')).toMatchObject({
      APPS_MAX_PER_WORKSPACE: 2,
      DOMAINS_MAX_PER_APP: 0,
    });
    expect(await provider({ APPS_MAX_PER_WORKSPACE: 0, DOMAINS_MAX_PER_APP: -1 }).forWorkspace('bad')).toMatchObject({
      APPS_MAX_PER_WORKSPACE: 50,
      DOMAINS_MAX_PER_APP: 3,
    });
    // A module limit still refuses 0.
    expect(await provider({ FORMS_PER_DAY: 0 }).forWorkspace('m')).toMatchObject({ FORMS_PER_DAY: 50 });
  });

  it('the env may set DOMAINS_MAX_PER_APP=0 (custom domains off server-wide)', () => {
    const p = createLimitsProvider({ catalogue: core, env: { DOMAINS_MAX_PER_APP: '0', APPS_MAX_PER_WORKSPACE: '0' } });
    expect(p.defaults()).toMatchObject({ DOMAINS_MAX_PER_APP: 0, APPS_MAX_PER_WORKSPACE: 50 });
  });

  it('docs/MODULES.md lists every core limit (the provider-side mirror)', () => {
    const doc = readFileSync(new URL('../../../docs/MODULES.md', import.meta.url), 'utf8');
    for (const l of CORE_LIMITS) expect(doc).toContain(`\`${l.env}\``);
  });
});
