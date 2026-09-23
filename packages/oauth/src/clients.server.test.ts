import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { oauthClients } from '@drobek/db';
import type { CimdCache } from './cimd.server.js';
import { resolveClient } from './client-resolve.server.js';
import {
  countUnusedDcrClients,
  createClient,
  markClientUsed,
  pruneUnusedDcrClients,
} from './clients.server.js';
import { maxUnusedDcrClients } from './routes/oauth.register.js';
import { freshDb, type TestDb } from './test/db.js';

let db: TestDb;
let close: () => Promise<void>;

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
});
afterAll(async () => close());

const REDIRECT = 'http://127.0.0.1:9999/cb';

describe('unused DCR clients (PHY-76 #7 cap)', () => {
  it('counts only never-authorized DCR clients and prunes the stale ones', async () => {
    const before = await countUnusedDcrClients();
    const used = await createClient({ clientName: 'used', redirectUris: [REDIRECT] });
    const fresh = await createClient({ clientName: 'fresh', redirectUris: [REDIRECT] });
    const stale = await createClient({ clientName: 'stale', redirectUris: [REDIRECT] });
    await markClientUsed(used.clientId);
    await db
      .update(oauthClients)
      .set({ createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000) })
      .where(eq(oauthClients.id, stale.id));
    expect(await countUnusedDcrClients()).toBe(before + 2);

    expect(await pruneUnusedDcrClients(new Date(Date.now() - 24 * 3600 * 1000))).toBe(1);
    const left = await db.select({ id: oauthClients.id }).from(oauthClients);
    const ids = left.map((r) => r.id);
    expect(ids).toContain(used.id);
    expect(ids).toContain(fresh.id);
    expect(ids).not.toContain(stale.id);
  });

  it('reads the cap from OAUTH_DCR_MAX_UNUSED_CLIENTS (default 500)', () => {
    expect(maxUnusedDcrClients({})).toBe(500);
    expect(maxUnusedDcrClients({ OAUTH_DCR_MAX_UNUSED_CLIENTS: '20' })).toBe(20);
    expect(maxUnusedDcrClients({ OAUTH_DCR_MAX_UNUSED_CLIENTS: 'nope' })).toBe(500);
  });
});

const noCache: CimdCache = { get: async () => null, set: async () => {} };

describe('resolveClient', () => {
  const url = 'https://agent.example/oauth/client.json';

  it('mirrors a valid CIMD document into oauth_clients (source cimd), following updates', async () => {
    const doc = (name: string, redirect: string) => async () => ({
      client_id: url,
      client_name: name,
      redirect_uris: [redirect],
    });
    const first = await resolveClient(url, { fetch: doc('Agent', REDIRECT), cache: noCache, env: {} });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.client).toMatchObject({ clientId: url, source: 'cimd', redirectUris: [REDIRECT] });

    const second = await resolveClient(url, {
      fetch: doc('Agent 2', 'https://agent.example/cb'),
      cache: noCache,
      env: {},
    });
    expect(second.ok && second.client.id).toBe(first.client.id);
    expect(second.ok && second.client.clientName).toBe('Agent 2');
    expect(second.ok && second.client.redirectUris).toEqual(['https://agent.example/cb']);
  });

  it('answers invalid_client for a bad document, an unknown DCR id, and a CIMD row without a document', async () => {
    const bad = await resolveClient(url, {
      fetch: async () => ({ client_id: 'https://evil.example/x.json', redirect_uris: [REDIRECT] }),
      cache: noCache,
      env: {},
    });
    expect(bad).toMatchObject({ ok: false, error: 'invalid_client' });
    expect(await resolveClient('deadbeef')).toMatchObject({ ok: false, error: 'invalid_client' });
  });

  it('resolves a registered DCR client by its id', async () => {
    const c = await createClient({ clientName: 'dcr', redirectUris: [REDIRECT] });
    const r = await resolveClient(c.clientId);
    expect(r.ok && r.client.source).toBe('dcr');
  });
});
