/**
 * OAuth crypto primitives (U5). Mirrors @drobek/auth's opaque-token pattern and
 * puls's oauth.server.ts: secrets are random + opaque, only their SHA-256 hash
 * is persisted, and PKCE is S256-only (plain is rejected upstream).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** SHA-256 hex of a token/code — what we store at rest, never the raw value. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Opaque, URL-safe random secret (default 32 bytes → 43-char base64url). */
export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Public client_id — 16 random bytes hex. */
export function generateClientId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * PKCE S256 verify: base64url(SHA-256(verifier)) === challenge. Constant-time
 * compare on equal-length inputs. Any non-S256 method must be rejected by the
 * caller BEFORE this is reached — this function only implements S256.
 */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  const computed = createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
