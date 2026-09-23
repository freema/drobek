/**
 * The form time token `_t` (M1-04): `GET /__drobek/v1/forms/:form/token`
 * issues `<issued-at base36>.<mac>`, the MAC = HMAC-SHA256 over the app id,
 * the form name and the issue time with a key derived (HKDF) from
 * DROBEK_MASTER_KEY — the key the server already refuses to start without in
 * production. A submission must carry a token of THIS app and form, at least
 * `FORM_MIN_FILL_MS` old (a human needs a moment to fill a form; a bot posts
 * at once) and at most `FORM_TOKEN_TTL_MS`. Tokens are not single-use: the
 * per-IP and per-app limits cap the volume.
 *
 * The same key hashes visitor IPs for storage (`ip_hash`): a keyed hash, so
 * the 2^32 IPv4 space cannot be brute-forced from a database dump.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

export const FORM_MIN_FILL_MS = 2_000;
export const FORM_TOKEN_TTL_MS = 2 * 60 * 60_000;
const CLOCK_SKEW_MS = 5_000;
const MAC_CHARS = 32;

/** The forms key, or null when DROBEK_MASTER_KEY is missing/malformed (the routes then fail closed). */
export function formsKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = (env.DROBEK_MASTER_KEY ?? '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) return null;
  return Buffer.from(hkdfSync('sha256', Buffer.from(raw, 'hex'), Buffer.alloc(0), 'drobek/forms-token/v1', 32));
}

function mac(key: Buffer, appId: string, form: string, issuedAt: number): string {
  return createHmac('sha256', key).update(`forms-token\n${appId}\n${form}\n${issuedAt}`).digest('base64url').slice(0, MAC_CHARS);
}

export function issueFormToken(key: Buffer, appId: string, form: string, now: number = Date.now()): string {
  return `${now.toString(36)}.${mac(key, appId, form, now)}`;
}

export type TokenCheck = { ok: true } | { ok: false; reason: 'invalid' | 'expired' } | { ok: false; reason: 'too_fast'; waitMs: number };

export function checkFormToken(key: Buffer, token: unknown, appId: string, form: string, now: number = Date.now()): TokenCheck {
  if (typeof token !== 'string' || token.length > 64) return { ok: false, reason: 'invalid' };
  const m = /^([0-9a-z]{1,12})\.([A-Za-z0-9_-]{32})$/.exec(token);
  if (!m) return { ok: false, reason: 'invalid' };
  const issuedAt = parseInt(m[1], 36);
  if (!Number.isSafeInteger(issuedAt)) return { ok: false, reason: 'invalid' };
  const expected = Buffer.from(mac(key, appId, form, issuedAt));
  const given = Buffer.from(m[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'invalid' };
  if (issuedAt > now + CLOCK_SKEW_MS) return { ok: false, reason: 'invalid' };
  if (now - issuedAt > FORM_TOKEN_TTL_MS) return { ok: false, reason: 'expired' };
  const age = now - issuedAt;
  if (age < FORM_MIN_FILL_MS) return { ok: false, reason: 'too_fast', waitMs: FORM_MIN_FILL_MS - age };
  return { ok: true };
}

/** A keyed, non-reversible hash of the visitor IP (null without an IP). */
export function ipHash(key: Buffer, appId: string, ip: string | null): string | null {
  if (!ip) return null;
  return createHmac('sha256', key).update(`forms-ip\n${appId}\n${ip}`).digest('hex').slice(0, 32);
}
