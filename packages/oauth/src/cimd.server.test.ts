import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CimdFetchError,
  checkCimdClientIdUrl,
  cimdDevOrigins,
  fetchCimdDocument,
  isUrlClientId,
  resolveCimdMetadata,
  validateCimdDocument,
  type CimdCache,
} from './cimd.server.js';
import { CIMD_MAX_BYTES } from './constants.js';

const CLIENT_ID = 'https://client.example/oauth/metadata.json';
const NONE = new Set<string>();

function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: CLIENT_ID,
    client_name: 'Example Agent',
    redirect_uris: ['https://client.example/callback', 'http://127.0.0.1:33418/cb'],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    ...overrides,
  };
}

describe('isUrlClientId', () => {
  it('tells a metadata URL from a DCR hex id', () => {
    expect(isUrlClientId(CLIENT_ID)).toBe(true);
    expect(isUrlClientId('http://proxy-echo:8099/x')).toBe(true);
    expect(isUrlClientId('3f2a9c0d1e4b5a6978c0d1e2f3a4b5c6')).toBe(false);
  });
});

describe('checkCimdClientIdUrl', () => {
  it('accepts a canonical https URL with a path', () => {
    const r = checkCimdClientIdUrl(CLIENT_ID, NONE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.devOrigin).toBe(false);
  });

  it.each([
    ['http://client.example/meta.json', 'https'],
    ['https://client.example:8443/meta.json', 'default https port'],
    ['https://client.example/', 'path'],
    ['https://client.example', 'path'],
    ['https://user:pw@client.example/meta.json', 'credentials'],
    ['https://client.example/meta.json#frag', 'fragment'],
    ['https://client.example/a/../meta.json', 'canonical'],
    ['https://Client.Example/meta.json', 'canonical'],
    ['https://client.example:443/meta.json', 'canonical'],
    ['not a url', 'valid URL'],
  ])('rejects %s (%s)', (raw, why) => {
    const r = checkCimdClientIdUrl(raw, NONE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(why);
  });

  it('lets ONLY an exact dev origin use http / a non-default port', () => {
    const dev = new Set(['http://proxy-echo:8099']);
    const ok = checkCimdClientIdUrl('http://proxy-echo:8099/cimd/a.json', dev);
    expect(ok.ok && ok.devOrigin).toBe(true);
    expect(checkCimdClientIdUrl('http://proxy-echo:8098/cimd/a.json', dev).ok).toBe(false);
    expect(checkCimdClientIdUrl('http://proxy-echo/cimd/a.json', dev).ok).toBe(false);
    // An https URL on the same host is NOT the dev origin → strict rules apply.
    const strict = checkCimdClientIdUrl('https://proxy-echo/cimd/a.json', dev);
    expect(strict.ok && strict.devOrigin).toBe(false);
  });
});

describe('cimdDevOrigins', () => {
  it('parses exact origins only and is disabled in production', () => {
    const env = {
      OAUTH_CIMD_DEV_ORIGINS: 'http://proxy-echo:8099, http://x:1/path, *, http://y:2/',
    };
    expect([...cimdDevOrigins({ ...env, NODE_ENV: 'development' })]).toEqual([
      'http://proxy-echo:8099',
    ]);
    expect(cimdDevOrigins({ ...env, NODE_ENV: 'production' }).size).toBe(0);
  });
});

describe('validateCimdDocument', () => {
  it('accepts a well-formed public-client document', () => {
    const r = validateCimdDocument(doc(), CLIENT_ID);
    expect(r).toEqual({
      ok: true,
      client: {
        clientId: CLIENT_ID,
        clientName: 'Example Agent',
        redirectUris: ['https://client.example/callback', 'http://127.0.0.1:33418/cb'],
      },
    });
  });

  it('requires the document client_id to equal its URL exactly', () => {
    const r = validateCimdDocument(doc({ client_id: 'https://evil.example/meta.json' }), CLIENT_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('does not match');
    expect(validateCimdDocument(doc({ client_id: `${CLIENT_ID}/` }), CLIENT_ID).ok).toBe(false);
  });

  it('applies the DCR redirect_uri policy', () => {
    for (const bad of [
      ['http://client.example/cb'], // http, not loopback
      ['https://client.example/cb#x'], // fragment
      [], // empty
      'https://client.example/cb', // not an array
      Array.from({ length: 11 }, (_, i) => `https://client.example/${i}`), // > cap
    ]) {
      expect(validateCimdDocument(doc({ redirect_uris: bad }), CLIENT_ID).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('rejects confidential-client documents and bad grant/response types', () => {
    expect(validateCimdDocument(doc({ client_secret: 's' }), CLIENT_ID).ok).toBe(false);
    expect(
      validateCimdDocument(doc({ token_endpoint_auth_method: 'private_key_jwt' }), CLIENT_ID).ok
    ).toBe(false);
    expect(validateCimdDocument(doc({ grant_types: ['client_credentials'] }), CLIENT_ID).ok).toBe(false);
    expect(validateCimdDocument(doc({ response_types: ['token'] }), CLIENT_ID).ok).toBe(false);
  });

  it('caps client_name and falls back to the host when absent', () => {
    expect(validateCimdDocument(doc({ client_name: 'x'.repeat(101) }), CLIENT_ID).ok).toBe(false);
    const r = validateCimdDocument(doc({ client_name: undefined }), CLIENT_ID);
    expect(r.ok && r.client.clientName).toBe('client.example');
  });

  it('rejects a non-object document', () => {
    expect(validateCimdDocument([doc()], CLIENT_ID).ok).toBe(false);
    expect(validateCimdDocument('x', CLIENT_ID).ok).toBe(false);
  });
});

function memoryCache(): CimdCache & { entries: Map<string, { value: string; ttl: number }> } {
  const entries = new Map<string, { value: string; ttl: number }>();
  return {
    entries,
    get: async (k) => entries.get(k)?.value ?? null,
    set: async (k, value, ttl) => {
      entries.set(k, { value, ttl });
    },
  };
}

describe('resolveCimdMetadata', () => {
  it('fetches once, then serves the validated result from the cache for an hour', async () => {
    const cache = memoryCache();
    let fetches = 0;
    const fetch = async () => {
      fetches++;
      return doc();
    };
    const first = await resolveCimdMetadata(CLIENT_ID, { fetch, cache, env: {} });
    const second = await resolveCimdMetadata(CLIENT_ID, { fetch, cache, env: {} });
    expect(first.ok && second.ok).toBe(true);
    expect(fetches).toBe(1);
    expect([...cache.entries.values()][0].ttl).toBe(3600);
  });

  it('caches a rejection only briefly and never fetches a structurally bad URL', async () => {
    const cache = memoryCache();
    let fetches = 0;
    const fetch = async () => {
      fetches++;
      return doc({ client_id: 'https://other.example/meta.json' });
    };
    const r = await resolveCimdMetadata(CLIENT_ID, { fetch, cache, env: {} });
    expect(r.ok).toBe(false);
    expect([...cache.entries.values()][0].ttl).toBe(60);

    const bad = await resolveCimdMetadata('http://client.example/meta.json', { fetch, cache, env: {} });
    expect(bad.ok).toBe(false);
    expect(fetches).toBe(1);
  });

  it('turns a fetch failure into a safe reason', async () => {
    const r = await resolveCimdMetadata(CLIENT_ID, {
      fetch: async () => {
        throw new CimdFetchError('metadata host resolves to a private or reserved address');
      },
      cache: memoryCache(),
      env: {},
    });
    expect(r).toEqual({
      ok: false,
      reason: 'metadata host resolves to a private or reserved address',
    });
  });
});

/**
 * The real fetch path (SSRF guard, size cap, timeout, no redirects) against a
 * loopback server. Loopback is a PRIVATE address, so the happy paths pass
 * allowPrivate (what a dev origin gets) and one test proves it is blocked
 * without it.
 */
describe('fetchCimdDocument', () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/ok') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ hello: 'world' }));
      } else if (req.url === '/big') {
        // No content-length: the cap must hold while streaming.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('"');
        res.write('x'.repeat(CIMD_MAX_BYTES + 10));
        res.end('"');
      } else if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
      } else if (req.url === '/slow') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{');
        // Drip a byte every second — never finishes within the 5 s budget.
        const t = setInterval(() => res.write(' '), 1000);
        res.on('close', () => clearInterval(t));
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('not json');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('fetches and parses a document from an allowed private origin', async () => {
    await expect(fetchCimdDocument(new URL(`${base}/ok`), { allowPrivate: true })).resolves.toEqual({
      hello: 'world',
    });
  });

  it('blocks a private/loopback address when not explicitly allowed', async () => {
    await expect(
      fetchCimdDocument(new URL(`${base}/ok`), { allowPrivate: false })
    ).rejects.toThrow(/private or reserved/);
  });

  it('enforces the 64 KiB cap while streaming', async () => {
    await expect(
      fetchCimdDocument(new URL(`${base}/big`), { allowPrivate: true })
    ).rejects.toThrow(/exceeds 65536 bytes/);
  });

  it('never follows a redirect', async () => {
    await expect(
      fetchCimdDocument(new URL(`${base}/redirect`), { allowPrivate: true })
    ).rejects.toThrow(/HTTP 302/);
  });

  it('rejects a non-JSON body', async () => {
    await expect(
      fetchCimdDocument(new URL(`${base}/text`), { allowPrivate: true })
    ).rejects.toThrow(/not valid JSON/);
  });

  it('gives up after the 5 s wall clock even while bytes keep dripping', async () => {
    const t0 = Date.now();
    await expect(
      fetchCimdDocument(new URL(`${base}/slow`), { allowPrivate: true })
    ).rejects.toThrow(/timed out/);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
    expect(elapsed).toBeLessThan(8_000);
  });
});
