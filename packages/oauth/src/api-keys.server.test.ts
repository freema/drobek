import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiKeys, users } from '@drobek/db';
import {
  createApiKey,
  generateApiKey,
  isApiKeyFormat,
  looksLikeApiKey,
  revokeApiKey,
  validateApiKey,
} from './api-keys.server.js';
import { API_KEY_LAST_USED_THROTTLE_MS } from './constants.js';
import { hashToken } from './crypto.server.js';
import { freshDb, type TestDb } from './test/db.js';

describe('API key format', () => {
  it('is drk_ + 32 base64url characters, random every time', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a).toMatch(/^drk_[A-Za-z0-9_-]{32}$/);
    expect(a).not.toBe(b);
    expect(isApiKeyFormat(a)).toBe(true);
  });

  it('rejects anything but the exact shape', () => {
    expect(isApiKeyFormat('drk_short')).toBe(false);
    expect(isApiKeyFormat(`drk_${'a'.repeat(33)}`)).toBe(false);
    expect(isApiKeyFormat(`drk_${'a'.repeat(31)}+`)).toBe(false);
    expect(isApiKeyFormat(`xyz_${'a'.repeat(32)}`)).toBe(false);
    expect(looksLikeApiKey('drk_anything')).toBe(true);
    expect(looksLikeApiKey('an-oauth-token')).toBe(false);
  });
});

describe('API keys in the database', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let userId: string;

  beforeAll(async () => {
    const t = await freshDb();
    db = t.db;
    close = () => t.pg.close();
    const [u] = await db.insert(users).values({ email: 'keys@example.test' }).returning();
    userId = u.id;
  });
  afterAll(async () => close());

  it('stores only the SHA-256 of the key, never the key', async () => {
    const created = await createApiKey({ userId, name: 'laptop', scopes: ['write', 'read'] });
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, created.id));
    expect(row.keyHash).toBe(hashToken(created.key));
    expect(JSON.stringify(row)).not.toContain(created.key);
    expect(row.scopes).toBe('read write');
    expect(row.name).toBe('laptop');
  });

  it('refuses an empty scope set or name', async () => {
    await expect(createApiKey({ userId, name: 'x', scopes: [] })).rejects.toThrow(/scope/);
    await expect(createApiKey({ userId, name: '  ', scopes: ['read'] })).rejects.toThrow(/name/);
  });

  it('validates by hash, throttles last_used_at, and stops at revocation', async () => {
    const created = await createApiKey({ userId, name: 'ci', scopes: ['read'] });
    const t0 = Date.now();
    expect(await validateApiKey(created.key, t0)).toEqual({
      id: created.id,
      userId,
      scope: 'read',
    });
    const lastUsed = async () =>
      (await db.select().from(apiKeys).where(eq(apiKeys.id, created.id)))[0].lastUsedAt?.getTime();
    expect(await lastUsed()).toBe(t0);

    // Within the throttle window the stamp does not move…
    await validateApiKey(created.key, t0 + 1_000);
    expect(await lastUsed()).toBe(t0);
    // …after it, it does.
    const later = t0 + API_KEY_LAST_USED_THROTTLE_MS + 1_000;
    await validateApiKey(created.key, later);
    expect(await lastUsed()).toBe(later);

    expect(await revokeApiKey(created.id)).toBe(true);
    expect(await revokeApiKey(created.id)).toBe(false);
    expect(await validateApiKey(created.key)).toBeNull();
  });

  it('rejects an unknown or malformed key without a match', async () => {
    expect(await validateApiKey(generateApiKey())).toBeNull();
    expect(await validateApiKey('drk_nope')).toBeNull();
  });
});
