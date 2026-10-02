import { describe, expect, it } from 'vitest';
import { redactAuditMeta } from './redact.js';

describe('redactAuditMeta', () => {
  it('replaces values under credential-like keys at any depth, keeps flags, names and counts', () => {
    expect(
      redactAuditMeta({
        module: 'auth',
        name: 'OIDC_CLIENT_SECRET',
        secret: 's3cr3t',
        rotated: true,
        hasSecret: false,
        items: [{ password: 'x', n: 1 }],
        nested: { api_key: 'k', privateKey: 'p', Cookie: 'c', count: 2, token: null },
      })
    ).toEqual({
      module: 'auth',
      name: 'OIDC_CLIENT_SECRET',
      secret: '[redacted]',
      rotated: true,
      hasSecret: false,
      items: [{ password: '[redacted]', n: 1 }],
      nested: { api_key: '[redacted]', privateKey: '[redacted]', Cookie: '[redacted]', count: 2, token: null },
    });
  });

  it('passes scalars through and stops at a depth limit', () => {
    expect(redactAuditMeta(null)).toBeNull();
    expect(redactAuditMeta('text')).toBe('text');
    let deep: unknown = 'leaf';
    for (let i = 0; i < 10; i++) deep = { d: deep };
    expect(JSON.stringify(redactAuditMeta(deep))).toContain('"[…]"');
  });

  it('does not change its input', () => {
    const meta = { token: 'x' };
    redactAuditMeta(meta);
    expect(meta).toEqual({ token: 'x' });
  });
});
