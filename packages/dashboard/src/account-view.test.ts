import { describe, expect, it } from 'vitest';
import {
  API_KEY_NAME_MAX,
  checkApiKeyForm,
  shapeApiKeys,
  shapeConnections,
} from './account-view.js';
import { sourceLink, SOURCE_REPO_URL } from './source-link.js';

const SCOPES = ['read', 'write', 'publish'] as const;

describe('checkApiKeyForm (M2-04 create form)', () => {
  it('accepts a trimmed name and orders the scopes canonically', () => {
    expect(checkApiKeyForm('  CI deploy ', ['publish', 'read', 'read'], SCOPES)).toEqual({
      ok: true,
      name: 'CI deploy',
      scopes: ['read', 'publish'],
    });
  });

  it('refuses an empty or over-long name', () => {
    expect(checkApiKeyForm('   ', ['read'], SCOPES)).toMatchObject({ ok: false });
    expect(checkApiKeyForm(null, ['read'], SCOPES)).toMatchObject({ ok: false });
    expect(checkApiKeyForm('x'.repeat(API_KEY_NAME_MAX + 1), ['read'], SCOPES)).toMatchObject({
      ok: false,
    });
  });

  it('refuses no scope and an unknown scope (never silently drops one)', () => {
    expect(checkApiKeyForm('k', [], SCOPES)).toEqual({ ok: false, error: 'Pick at least one scope.' });
    expect(checkApiKeyForm('k', ['read', 'admin'], SCOPES)).toEqual({ ok: false, error: 'Unknown scope.' });
  });
});

describe('shapeApiKeys', () => {
  it('lists active keys newest first, then revoked ones; never-used shows a dash', () => {
    const shaped = shapeApiKeys([
      {
        id: 'k1',
        name: 'old',
        scopes: 'read',
        createdAt: new Date('2026-09-01T10:00:00Z'),
        lastUsedAt: new Date('2026-09-02T08:30:00Z'),
        revokedAt: null,
      },
      {
        id: 'k2',
        name: 'gone',
        scopes: 'read write',
        createdAt: new Date('2026-09-05T10:00:00Z'),
        lastUsedAt: null,
        revokedAt: new Date('2026-09-06T10:00:00Z'),
      },
      {
        id: 'k3',
        name: 'new',
        scopes: 'read write publish',
        createdAt: new Date('2026-09-10T10:00:00Z'),
        lastUsedAt: null,
        revokedAt: null,
      },
    ]);
    expect(shaped.map((k) => [k.id, k.status])).toEqual([
      ['k3', 'active'],
      ['k1', 'active'],
      ['k2', 'revoked'],
    ]);
    expect(shaped[0]).toMatchObject({ scopes: ['read', 'write', 'publish'], lastUsed: '—', revoked: null });
    expect(shaped[1].lastUsed).toBe('2026-09-02 08:30 UTC');
    expect(shaped[2].revoked).toBe('2026-09-06 10:00 UTC');
  });
});

describe('shapeConnections', () => {
  it('labels the registration source and splits the scopes', () => {
    const [c] = shapeConnections([
      {
        oauthClientId: 'row1',
        clientId: 'https://agent.example/cimd.json',
        clientName: 'Agent',
        source: 'cimd',
        scope: 'read write',
        lastUsedAt: new Date('2026-09-23T09:15:00Z'),
      },
    ]);
    expect(c).toEqual({
      id: 'row1',
      clientId: 'https://agent.example/cimd.json',
      name: 'Agent',
      source: 'cimd',
      sourceLabel: 'Client ID Metadata Document',
      scopes: ['read', 'write'],
      lastUsed: '2026-09-23 09:15 UTC',
    });
  });
});

describe('sourceLink (AGPL-3.0 §13 footer)', () => {
  it('links a build sha to its commit in freema/drobek', () => {
    expect(sourceLink('9130f7e')).toEqual({
      href: 'https://github.com/freema/drobek/commit/9130f7e',
      label: 'Source (AGPL-3.0) · 9130f7e',
      sha: '9130f7e',
    });
    const full = '9130f7e0123456789abcdef0123456789abcdef0';
    expect(sourceLink(full)).toMatchObject({
      href: `${SOURCE_REPO_URL}/commit/${full}`,
      label: 'Source (AGPL-3.0) · 9130f7e',
    });
  });

  it('falls back to the branch tree without a real sha (dev, empty, junk)', () => {
    for (const raw of ['dev', '', undefined, null, 'abc', '"><script>', 'zzzzzzz']) {
      expect(sourceLink(raw)).toEqual({
        href: 'https://github.com/freema/drobek/tree/main',
        label: 'Source (AGPL-3.0) · dev',
        sha: null,
      });
    }
  });
});
