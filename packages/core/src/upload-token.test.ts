import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mintUploadToken, verifyUploadToken } from './upload-token.js';

const SECRET = 'unit-test-signing-secret';
const SHA = createHash('sha256').update('payload').digest('hex');

describe('upload token mint/verify', () => {
  it('round-trips a valid token', () => {
    const token = mintUploadToken(
      { sha256: SHA, maxBytes: 1024, ttlSec: 300 },
      SECRET
    );
    // Single path-safe segment: base64url payload + "." + base64url sig.
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const verdict = verifyUploadToken(token, SECRET);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.payload.sha256).toBe(SHA);
      expect(verdict.payload.maxBytes).toBe(1024);
      expect(verdict.payload.exp).toBe(Math.floor(Date.now() / 1000) + 300);
    }
  });

  it('rejects an expired token', () => {
    const token = mintUploadToken(
      { sha256: SHA, maxBytes: 1024, ttlSec: -10 },
      SECRET
    );
    expect(verifyUploadToken(token, SECRET)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('expires exactly at exp (valid while now < exp)', () => {
    const now = 1_700_000_000_000;
    const token = mintUploadToken(
      { sha256: SHA, maxBytes: 1, ttlSec: 60 },
      SECRET,
      now
    );
    expect(verifyUploadToken(token, SECRET, now + 59_999).ok).toBe(true);
    expect(verifyUploadToken(token, SECRET, now + 60_000)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects a tampered payload (signature no longer matches)', () => {
    const token = mintUploadToken(
      { sha256: SHA, maxBytes: 16, ttlSec: 300 },
      SECRET
    );
    const [payloadB64, sig] = token.split('.');
    const payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8')
    );
    payload.maxBytes = 1_000_000_000; // attacker raises their own cap
    const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;

    expect(verifyUploadToken(forged, SECRET)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('rejects a token signed with a different secret', () => {
    const token = mintUploadToken(
      { sha256: SHA, maxBytes: 1024, ttlSec: 300 },
      'some-other-secret'
    );
    expect(verifyUploadToken(token, SECRET)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('rejects malformed tokens', () => {
    for (const bad of ['', 'garbage', 'a.b.c', '.', 'onlyonepart', 'x.', '.y']) {
      const verdict = verifyUploadToken(bad, SECRET);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(['malformed', 'bad-signature']).toContain(verdict.reason);
      }
    }
  });

  it('rejects a correctly signed but non-JSON payload as malformed', () => {
    // Sign arbitrary non-payload bytes with the REAL secret.
    const payloadB64 = Buffer.from('not json at all').toString('base64url');
    const sig = createHmac('sha256', SECRET)
      .update(payloadB64)
      .digest('base64url');
    expect(verifyUploadToken(`${payloadB64}.${sig}`, SECRET)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('mint validates its inputs', () => {
    expect(() =>
      mintUploadToken({ sha256: 'nope', maxBytes: 1, ttlSec: 1 }, SECRET)
    ).toThrow(/sha256/);
    expect(() =>
      mintUploadToken({ sha256: SHA, maxBytes: 0, ttlSec: 1 }, SECRET)
    ).toThrow(/maxBytes/);
    expect(() =>
      mintUploadToken({ sha256: SHA, maxBytes: 1.5, ttlSec: 1 }, SECRET)
    ).toThrow(/maxBytes/);
    expect(() =>
      mintUploadToken({ sha256: SHA, maxBytes: 1, ttlSec: 1 }, '')
    ).toThrow(/secret/);
    expect(() => verifyUploadToken('a.b', '')).toThrow(/secret/);
  });
});
