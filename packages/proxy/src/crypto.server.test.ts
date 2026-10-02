import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  kekFromEnv,
  keyOf,
  keyRingFromEnv,
  previousKekFromEnv,
  rewrapSecret,
} from './crypto.server.js';
import { ProxyError } from './errors.js';

const KEY_A = 'a'.repeat(64); // 32 bytes hex
const KEY_B = 'b'.repeat(64); // a DIFFERENT 32-byte key (rotation)

const envA = { DROBEK_MASTER_KEY: KEY_A } as NodeJS.ProcessEnv;
const envB = { DROBEK_MASTER_KEY: KEY_B } as NodeJS.ProcessEnv;

describe('kekFromEnv — fail closed', () => {
  it('throws when the key is missing', () => {
    expect(() => kekFromEnv({} as NodeJS.ProcessEnv)).toThrow(ProxyError);
  });
  it('throws when a passphrase is too short', () => {
    expect(() =>
      kekFromEnv({ DROBEK_MASTER_KEY: 'short' } as NodeJS.ProcessEnv)
    ).toThrow(ProxyError);
  });
  it('derives a stable non-secret kek id', () => {
    expect(kekFromEnv(envA).id).toBe(kekFromEnv(envA).id);
    expect(kekFromEnv(envA).id).not.toBe(kekFromEnv(envB).id);
    // The id never contains the raw key material.
    expect(kekFromEnv(envA).id).not.toContain(KEY_A);
  });
});

describe('envelope round-trip', () => {
  it('encrypt → decrypt returns the plaintext', () => {
    const env = encryptSecret('super-secret-token', envA);
    expect(env.ciphertext).not.toContain('super-secret-token');
    expect(decryptSecret(env, envA)).toBe('super-secret-token');
  });

  it('captures the kek_id and uses a fresh DEK per secret', () => {
    const a = encryptSecret('same-plaintext-for-both', envA);
    const b = encryptSecret('same-plaintext-for-both', envA);
    expect(a.kekId).toBe(kekFromEnv(envA).id);
    // Same plaintext + same KEK → DIFFERENT ciphertext (random DEK + IV). A 1-byte
    // plaintext would collide 1 in 256 runs, so the plaintext is long.
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedDek).not.toBe(b.wrappedDek);
  });

  it('handles unicode + long secrets', () => {
    const secret = 'ключ-🔑-' + 'z'.repeat(500);
    expect(decryptSecret(encryptSecret(secret, envA), envA)).toBe(secret);
  });
});

describe('wrong / rotated KEK fails closed', () => {
  it('a different DROBEK_MASTER_KEY → config_error (kek_id mismatch)', () => {
    const env = encryptSecret('s', envA);
    try {
      decryptSecret(env, envB);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ProxyError);
      expect((e as ProxyError).code).toBe('config_error');
    }
  });

  it('a tampered ciphertext (auth-tag fail) → config_error, never a leak', () => {
    const env = encryptSecret('s', envA);
    const tampered = { ...env, ciphertext: Buffer.from('zzzz').toString('base64') };
    try {
      decryptSecret(tampered, envA);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ProxyError).code).toBe('config_error');
    }
  });

  it('a tampered wrapped DEK → config_error', () => {
    const env = encryptSecret('s', envA);
    const tampered = { ...env, wrappedDek: env.wrappedDek.replace(/.$/, 'A') };
    expect(() => decryptSecret(tampered, envA)).toThrow(ProxyError);
  });
});

const KEY_C = 'c'.repeat(64);
/** Rotated from A to B: B is current, A is still accepted for reading. */
const rotating = { DROBEK_MASTER_KEY: KEY_B, DROBEK_MASTER_KEY_PREVIOUS: KEY_A } as NodeJS.ProcessEnv;

describe('DROBEK_MASTER_KEY_PREVIOUS during a rotation', () => {
  it('decrypts an envelope of the previous key; new envelopes use the current key', () => {
    const old = encryptSecret('written-before-the-rotation', envA);
    expect(decryptSecret(old, rotating)).toBe('written-before-the-rotation');
    const fresh = encryptSecret('written-after-the-rotation', rotating);
    expect(fresh.kekId).toBe(kekFromEnv(envB).id);
    expect(decryptSecret(fresh, rotating)).toBe('written-after-the-rotation');
    expect(decryptSecret(fresh, envB)).toBe('written-after-the-rotation');
  });

  it('an envelope of a third key fails closed and names both variables, never a value', () => {
    const third = encryptSecret('s', { DROBEK_MASTER_KEY: KEY_C } as NodeJS.ProcessEnv);
    let caught: unknown;
    try {
      decryptSecret(third, rotating);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProxyError);
    expect((caught as ProxyError).code).toBe('config_error');
    expect((caught as ProxyError).message).toContain('DROBEK_MASTER_KEY_PREVIOUS');
    for (const k of [KEY_A, KEY_B, KEY_C]) expect((caught as ProxyError).message).not.toContain(k);
  });

  it('a malformed previous key fails closed with its own name', () => {
    expect(() => previousKekFromEnv({ DROBEK_MASTER_KEY_PREVIOUS: 'short' } as NodeJS.ProcessEnv)).toThrow(/DROBEK_MASTER_KEY_PREVIOUS/);
    expect(() => decryptSecret(encryptSecret('s', envB), { ...envB, DROBEK_MASTER_KEY_PREVIOUS: 'short' })).toThrow(ProxyError);
    expect(previousKekFromEnv(envA)).toBeNull();
    expect(previousKekFromEnv({ DROBEK_MASTER_KEY_PREVIOUS: '  ' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('accepts a passphrase as the previous key, the way DROBEK_MASTER_KEY does', () => {
    const passphrase = 'a long passphrase of more than thirty-two characters';
    const old = encryptSecret('from-a-passphrase', { DROBEK_MASTER_KEY: passphrase } as NodeJS.ProcessEnv);
    expect(decryptSecret(old, { DROBEK_MASTER_KEY: KEY_B, DROBEK_MASTER_KEY_PREVIOUS: passphrase })).toBe('from-a-passphrase');
  });

  it('the key ring drops a previous key equal to the current one', () => {
    expect(keyRingFromEnv({ DROBEK_MASTER_KEY: KEY_A, DROBEK_MASTER_KEY_PREVIOUS: KEY_A }).previous).toBeNull();
    const ring = keyRingFromEnv(rotating);
    expect(ring.previous?.id).toBe(kekFromEnv(envA).id);
    expect(keyOf(ring, kekFromEnv(envB).id)).toBe('current');
    expect(keyOf(ring, kekFromEnv(envA).id)).toBe('previous');
    expect(keyOf(ring, 'v1')).toBe('unknown');
    expect(keyOf(ring, 'ž'.repeat(16))).toBe('unknown');
  });
});

describe('rewrapSecret', () => {
  it('re-wraps only the DEK: same ciphertext, current kek_id, readable without the previous key', () => {
    const old = encryptSecret('moved-to-the-new-key', envA);
    const r = rewrapSecret(old, keyRingFromEnv(rotating));
    if (r.status !== 'rewrapped') throw new Error(`expected rewrapped, got ${r.status}`);
    expect(r.kekId).toBe(kekFromEnv(envB).id);
    expect(r.wrappedDek).not.toBe(old.wrappedDek);
    const moved = { ...old, wrappedDek: r.wrappedDek, kekId: r.kekId };
    expect(decryptSecret(moved, envB)).toBe('moved-to-the-new-key');
    expect(() => decryptSecret(moved, envA)).toThrow(ProxyError);
  });

  it('leaves an envelope of the current key alone', () => {
    expect(rewrapSecret(encryptSecret('s', envB), keyRingFromEnv(rotating))).toEqual({ status: 'current' });
  });

  it('reports an envelope of an unknown key and a damaged one of the previous key', () => {
    const ring = keyRingFromEnv(rotating);
    expect(rewrapSecret(encryptSecret('s', { DROBEK_MASTER_KEY: KEY_C } as NodeJS.ProcessEnv), ring)).toEqual({ status: 'unknown_key' });
    expect(rewrapSecret(encryptSecret('s', envA), keyRingFromEnv(envB))).toEqual({ status: 'unknown_key' });
    const old = encryptSecret('s', envA);
    expect(rewrapSecret({ ...old, wrappedDek: old.wrappedDek.replace(/.$/, 'A') }, ring)).toEqual({ status: 'unreadable' });
    expect(rewrapSecret({ ...old, wrappedDek: 'not-an-envelope' }, ring)).toEqual({ status: 'unreadable' });
  });
});
