/**
 * Signed-upload tokens — PHY-100 (CRIT).
 *
 * Single path token for `PUT /__upload/<token>`:
 *
 *   token   = base64url(payloadJSON) + "." + base64url(hmacSha256(secret, base64url(payloadJSON)))
 *   payload = { sha256, maxBytes, exp }   // exp = unix SECONDS
 *
 * `maxBytes` is BOUND INTO the signature — the server enforces the cap the
 * token was minted with, never a client-declared length. Verification is
 * signature-first (unauthenticated input is never JSON-parsed) with a
 * constant-time compare.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isSha256Hex } from './blob-store.js';

export type UploadTokenPayload = {
  /** Content address the uploaded bytes MUST hash to. */
  sha256: string;
  /** Hard byte cap for the upload body. */
  maxBytes: number;
  /** Expiry, unix seconds. The token is valid while `now < exp`. */
  exp: number;
};

export type UploadTokenVerdict =
  | { ok: true; payload: UploadTokenPayload }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' };

function requireSecret(secret: string): void {
  if (!secret) {
    throw new Error('upload token secret must be a non-empty string');
  }
}

function sign(payloadB64: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payloadB64).digest();
}

/** Mint a signed upload token. `ttlSec` may be negative (tests). */
export function mintUploadToken(
  input: { sha256: string; maxBytes: number; ttlSec: number },
  secret: string,
  nowMs: number = Date.now()
): string {
  requireSecret(secret);
  const { sha256, maxBytes, ttlSec } = input;
  if (!isSha256Hex(sha256)) {
    throw new Error(`not a lowercase-hex sha256: ${JSON.stringify(sha256)}`);
  }
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`maxBytes must be a positive integer, got ${maxBytes}`);
  }
  if (!Number.isInteger(ttlSec)) {
    throw new Error(`ttlSec must be an integer, got ${ttlSec}`);
  }
  const payload: UploadTokenPayload = {
    sha256,
    maxBytes,
    exp: Math.floor(nowMs / 1000) + ttlSec,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url'
  );
  const sig = sign(payloadB64, secret).toString('base64url');
  return `${payloadB64}.${sig}`;
}

function parsePayload(payloadB64: string): UploadTokenPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { sha256, maxBytes, exp } = parsed as Record<string, unknown>;
  if (typeof sha256 !== 'string' || !isSha256Hex(sha256)) return null;
  if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes <= 0) {
    return null;
  }
  if (typeof exp !== 'number' || !Number.isInteger(exp)) return null;
  return { sha256, maxBytes, exp };
}

/** Verify a token: shape → signature (constant-time) → payload → expiry. */
export function verifyUploadToken(
  token: string,
  secret: string,
  nowMs: number = Date.now()
): UploadTokenVerdict {
  requireSecret(secret);
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: 'malformed' };
  }
  const [payloadB64, sigB64] = parts;

  const expected = sign(payloadB64, secret);
  const presented = Buffer.from(sigB64, 'base64url');
  if (
    presented.length !== expected.length ||
    !timingSafeEqual(presented, expected)
  ) {
    return { ok: false, reason: 'bad-signature' };
  }

  const payload = parsePayload(payloadB64);
  if (!payload) {
    // Signed by us but undecodable — treat as malformed.
    return { ok: false, reason: 'malformed' };
  }

  if (Math.floor(nowMs / 1000) >= payload.exp) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, payload };
}
