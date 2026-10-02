/**
 * Envelope encryption for upstream and module secrets.
 *
 * AES-256-GCM, envelope scheme: a fresh random DEK encrypts the secret; the DEK
 * is WRAPPED (encrypted) by the KEK derived from env `DROBEK_MASTER_KEY`. Only
 * the wrapped DEK + ciphertext are persisted — the plaintext secret and the DEK
 * exist in memory ONLY at encrypt/decrypt time and are NEVER logged or returned.
 *
 * Rotation: while `DROBEK_MASTER_KEY_PREVIOUS` holds the key used before,
 * envelopes wrapped by it still decrypt; every new envelope uses the current
 * key. `rewrapSecret` moves one envelope to the current key by re-wrapping its
 * DEK — the ciphertext and the plaintext are never touched.
 *
 * Fails CLOSED:
 *   - a missing/short DROBEK_MASTER_KEY when a secret op runs → throws (500), the
 *     proxy never forwards without the configured secret.
 *   - an envelope wrapped by neither key → the `kek_id` mismatch OR the GCM
 *     auth-tag verify throws → config_error (500), never a silent leak or a
 *     partial plaintext.
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

const MASTER_KEY_ENV = 'DROBEK_MASTER_KEY';
const PREVIOUS_MASTER_KEY_ENV = 'DROBEK_MASTER_KEY_PREVIOUS';

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

/** The KEKs this server holds: the current one wraps every new DEK, the previous one only unwraps. */
export interface KeyRing {
  current: Kek;
  previous: Kek | null;
}

function kekFromValue(name: string, raw: string): Kek {
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    // Accept a raw passphrase too, but require ≥32 bytes of entropy material.
    const buf = Buffer.from(raw, 'utf8');
    if (buf.length < 32) {
      throw new ProxyError(
        'config_error',
        `${name} must be 32 bytes (64 hex chars) or a ≥32-char passphrase`
      );
    }
    // Fold to exactly 32 bytes deterministically.
    key = createHash('sha256').update(buf).digest();
  }
  if (key.length !== 32) {
    throw new ProxyError('config_error', `${name} must derive to 32 bytes`);
  }
  const id = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return { key, id };
}

/**
 * Derive the KEK from `DROBEK_MASTER_KEY` (64 hex chars = 32 bytes). Fails closed
 * if the env var is missing or too short — a secret op MUST NOT proceed without a
 * strong key. `kekId` = sha256(key) prefix, so rotation is detectable without
 * ever storing/deriving-from the raw key material.
 */
export function kekFromEnv(env: NodeJS.ProcessEnv = process.env): Kek {
  const raw = (env[MASTER_KEY_ENV] ?? '').trim();
  if (raw === '') {
    throw new ProxyError(
      'config_error',
      `${MASTER_KEY_ENV} is required for the secret store`
    );
  }
  return kekFromValue(MASTER_KEY_ENV, raw);
}

/**
 * The KEK from `DROBEK_MASTER_KEY_PREVIOUS` (same format rules), or null when
 * it is unset. Throws config_error on a malformed value.
 */
export function previousKekFromEnv(env: NodeJS.ProcessEnv = process.env): Kek | null {
  const raw = (env[PREVIOUS_MASTER_KEY_ENV] ?? '').trim();
  return raw === '' ? null : kekFromValue(PREVIOUS_MASTER_KEY_ENV, raw);
}

/** The current KEK and the previous one (null when unset or equal to the current one). */
export function keyRingFromEnv(env: NodeJS.ProcessEnv = process.env): KeyRing {
  const current = kekFromEnv(env);
  const previous = previousKekFromEnv(env);
  return { current, previous: previous && !sameId(previous.id, current.id) ? previous : null };
}

function sameId(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Which key of the ring wrapped an envelope with this `kek_id`. */
export function keyOf(ring: KeyRing, kekId: string): 'current' | 'previous' | 'unknown' {
  if (sameId(ring.current.id, kekId)) return 'current';
  if (ring.previous && sameId(ring.previous.id, kekId)) return 'previous';
  return 'unknown';
}

function wrapDek(dek: Buffer, kek: Kek): string {
  const wrapIv = randomBytes(IV_LEN);
  const wrapCipher = createCipheriv(ALGO, kek.key, wrapIv);
  const wrappedCt = Buffer.concat([wrapCipher.update(dek), wrapCipher.final()]);
  const wrapTag = wrapCipher.getAuthTag();
  return [
    wrapIv.toString('base64'),
    wrapTag.toString('base64'),
    wrappedCt.toString('base64'),
  ].join('.');
}

/** The DEK inside `wrappedDek`; throws on a malformed value or a failed auth tag. */
function unwrapDek(wrappedDek: string, kek: Kek): Buffer {
  const [wrapIvB64, wrapTagB64, wrappedCtB64] = wrappedDek.split('.');
  if (!wrapIvB64 || !wrapTagB64 || !wrappedCtB64) {
    throw new Error('malformed wrapped_dek');
  }
  const wrapDecipher = createDecipheriv(ALGO, kek.key, Buffer.from(wrapIvB64, 'base64'));
  wrapDecipher.setAuthTag(Buffer.from(wrapTagB64, 'base64'));
  return Buffer.concat([
    wrapDecipher.update(Buffer.from(wrappedCtB64, 'base64')),
    wrapDecipher.final(),
  ]);
}

/** Encrypt a plaintext secret into a persistable envelope (random DEK, wrapped by the current key). */
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
  return {
    ciphertext: ct.toString('base64'),
    iv: iv.toString('base64'),
    authTag: tag.toString('base64'),
    wrappedDek: wrapDek(dek, kek),
    kekId: kek.id,
  };
}

/**
 * Decrypt an envelope back to the plaintext secret (in memory only), with the
 * current key or, during a rotation, the previous one. Throws config_error on
 * an envelope wrapped by neither key (kek_id mismatch or auth-tag failure) or
 * any malformed field — never returns a partial/garbage plaintext.
 */
export function decryptSecret(
  env0: SecretEnvelope,
  env: NodeJS.ProcessEnv = process.env
): string {
  const ring = keyRingFromEnv(env);
  const which = keyOf(ring, env0.kekId);
  if (which === 'unknown') {
    throw new ProxyError(
      'config_error',
      `secret was wrapped by a key this server does not have (neither ${MASTER_KEY_ENV} nor ${PREVIOUS_MASTER_KEY_ENV})`
    );
  }
  const kek = which === 'current' ? ring.current : ring.previous!;

  try {
    const dek = unwrapDek(env0.wrappedDek, kek);
    const decipher = createDecipheriv(ALGO, dek, Buffer.from(env0.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(env0.authTag, 'base64'));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(env0.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return pt.toString('utf8');
  } catch {
    // GCM auth failure / malformed input → fail CLOSED. No secret material in msg.
    throw new ProxyError('config_error', 'secret could not be decrypted');
  }
}

/** What `rewrapSecret` did with one envelope. */
export type RewrapResult =
  | { status: 'current' }
  | { status: 'rewrapped'; wrappedDek: string; kekId: string }
  | { status: 'unknown_key' }
  | { status: 'unreadable' };

/**
 * Move one envelope to the current key: unwrap its DEK with the previous key
 * and wrap it again with the current one. The ciphertext, IV and auth tag stay
 * as they are; only `wrappedDek` + `kekId` change. `current` = nothing to do,
 * `unknown_key` = wrapped by neither key, `unreadable` = wrapped by the
 * previous key but its wrapped DEK does not open (damaged).
 */
export function rewrapSecret(
  envelope: Pick<SecretEnvelope, 'wrappedDek' | 'kekId'>,
  ring: KeyRing
): RewrapResult {
  const which = keyOf(ring, envelope.kekId);
  if (which === 'current') return { status: 'current' };
  if (which === 'unknown') return { status: 'unknown_key' };
  let dek: Buffer;
  try {
    dek = unwrapDek(envelope.wrappedDek, ring.previous!);
  } catch {
    return { status: 'unreadable' };
  }
  return { status: 'rewrapped', wrappedDek: wrapDek(dek, ring.current), kekId: ring.current.id };
}
