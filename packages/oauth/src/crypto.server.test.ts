import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateClientId,
  generateOpaqueToken,
  hashToken,
  verifyPkceS256,
} from './crypto.server.js';

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

describe('hashToken', () => {
  it('is a deterministic 64-char sha-256 hex', () => {
    const h = hashToken('hello');
    expect(h).toBe(hashToken('hello'));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('generateOpaqueToken / generateClientId', () => {
  it('are unique and URL-safe', () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(generateClientId()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('verifyPkceS256', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

  it('accepts the matching S256 challenge', () => {
    expect(verifyPkceS256(verifier, s256(verifier))).toBe(true);
  });

  it('rejects a mismatched challenge', () => {
    expect(verifyPkceS256(verifier, s256('other-verifier'))).toBe(false);
  });

  it('rejects a plain (unhashed) challenge', () => {
    // "plain" PKCE would send the verifier as the challenge — must fail S256.
    expect(verifyPkceS256(verifier, verifier)).toBe(false);
  });

  it('rejects empty inputs', () => {
    expect(verifyPkceS256('', s256(''))).toBe(false);
    expect(verifyPkceS256(verifier, '')).toBe(false);
  });
});
