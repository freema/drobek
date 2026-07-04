import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, kekFromEnv } from './crypto.server.js';
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
    const a = encryptSecret('x', envA);
    const b = encryptSecret('x', envA);
    expect(a.kekId).toBe(kekFromEnv(envA).id);
    // Same plaintext + same KEK → DIFFERENT ciphertext (random DEK + IV).
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
