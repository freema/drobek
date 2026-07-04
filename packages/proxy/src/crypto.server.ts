/**
 * Envelope encryption for upstream secrets (PHY-59, R6 security core).
 *
 * AES-256-GCM, envelope scheme: a fresh random DEK encrypts the secret; the DEK
 * is WRAPPED (encrypted) by the KEK derived from env `DROBEK_MASTER_KEY`. Only
 * the wrapped DEK + ciphertext are persisted — the plaintext secret and the DEK
 * exist in memory ONLY at encrypt/decrypt time and are NEVER logged or returned.
 *
 * Fails CLOSED:
 *   - a missing/short DROBEK_MASTER_KEY when a secret op runs → throws (500), the
 *     proxy never forwards without the configured secret.
 *   - a wrong/rotated KEK → the `kek_id` mismatch OR the GCM auth-tag verify
 *     throws → config_error (500), never a silent leak or a partial plaintext.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { ProxyError } from './errors.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

export interface SecretEnvelope {
  ciphertext: string;
  iv: string;
  authTag: string;
  wrappedDek: string;
  kekId: string;
}

/** A 32-byte KEK + its stable, non-secret id (sha256 prefix). */
interface Kek {
  key: Buffer;
  id: string;
}

/**
 * Derive the KEK from `DROBEK_MASTER_KEY` (64 hex chars = 32 bytes). Fails closed
 * if the env var is missing or too short — a secret op MUST NOT proceed without a
 * strong key. `kekId` = sha256(key) prefix, so rotation is detectable without
 * ever storing/deriving-from the raw key material.
 */
export function kekFromEnv(env: NodeJS.ProcessEnv = process.env): Kek {
  const raw = (env.DROBEK_MASTER_KEY ?? '').trim();
  if (raw === '') {
    throw new ProxyError(
      'config_error',
      'DROBEK_MASTER_KEY is required for the proxy secret store'
    );
  }
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    // Accept a raw passphrase too, but require ≥32 bytes of entropy material.
    const buf = Buffer.from(raw, 'utf8');
    if (buf.length < 32) {
      throw new ProxyError(
        'config_error',
        'DROBEK_MASTER_KEY must be 32 bytes (64 hex chars) or a ≥32-char passphrase'
      );
    }
    // Fold to exactly 32 bytes deterministically.
    key = createHash('sha256').update(buf).digest();
  }
  if (key.length !== 32) {
    throw new ProxyError('config_error', 'DROBEK_MASTER_KEY must derive to 32 bytes');
  }
  const id = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return { key, id };
}

/** Encrypt a plaintext secret into a persistable envelope (random DEK, wrapped). */
export function encryptSecret(
  plaintext: string,
  env: NodeJS.ProcessEnv = process.env
): SecretEnvelope {
  const kek = kekFromEnv(env);

  // 1) Encrypt the secret under a fresh DEK.
  const dek = randomBytes(32);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, dek, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // 2) Wrap the DEK under the KEK. The wrap iv+tag live inside `wrappedDek`.
  const wrapIv = randomBytes(IV_LEN);
  const wrapCipher = createCipheriv(ALGO, kek.key, wrapIv);
  const wrappedCt = Buffer.concat([wrapCipher.update(dek), wrapCipher.final()]);
  const wrapTag = wrapCipher.getAuthTag();
  const wrappedDek = [
    wrapIv.toString('base64'),
    wrapTag.toString('base64'),
    wrappedCt.toString('base64'),
  ].join('.');

  return {
    ciphertext: ct.toString('base64'),
    iv: iv.toString('base64'),
    authTag: tag.toString('base64'),
    wrappedDek,
    kekId: kek.id,
  };
}

/**
 * Decrypt an envelope back to the plaintext secret (in memory only). Throws
 * config_error on a wrong/rotated KEK (kek_id mismatch or auth-tag failure) or
 * any malformed field — never returns a partial/garbage plaintext.
 */
export function decryptSecret(
  env0: SecretEnvelope,
  env: NodeJS.ProcessEnv = process.env
): string {
  const kek = kekFromEnv(env);
  if (
    kek.id.length !== env0.kekId.length ||
    !timingSafeEqual(Buffer.from(kek.id), Buffer.from(env0.kekId))
  ) {
    throw new ProxyError(
      'config_error',
      'upstream secret was wrapped by a different DROBEK_MASTER_KEY'
    );
  }

  try {
    // Unwrap the DEK.
    const [wrapIvB64, wrapTagB64, wrappedCtB64] = env0.wrappedDek.split('.');
    if (!wrapIvB64 || !wrapTagB64 || !wrappedCtB64) {
      throw new Error('malformed wrapped_dek');
    }
    const wrapDecipher = createDecipheriv(
      ALGO,
      kek.key,
      Buffer.from(wrapIvB64, 'base64')
    );
    wrapDecipher.setAuthTag(Buffer.from(wrapTagB64, 'base64'));
    const dek = Buffer.concat([
      wrapDecipher.update(Buffer.from(wrappedCtB64, 'base64')),
      wrapDecipher.final(),
    ]);

    // Decrypt the secret under the DEK.
    const decipher = createDecipheriv(ALGO, dek, Buffer.from(env0.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(env0.authTag, 'base64'));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(env0.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return pt.toString('utf8');
  } catch {
    // GCM auth failure / malformed input → fail CLOSED. No secret material in msg.
    throw new ProxyError('config_error', 'upstream secret could not be decrypted');
  }
}
