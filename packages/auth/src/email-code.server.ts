/**
 * Email magic-code auth — code create/consume (ported from puls, U2 deltas):
 * - 6-digit NUMERIC code (crypto randomInt per digit, leading zeros allowed).
 * - Stored as SHA-256 hex in `drobek:otp:code:<sha256(email)>`, TTL 600 s.
 * - Max 5 guesses per code, tracked by an ATOMIC counter in a sibling key
 *   `drobek:otp:attempts:<sha256(email)>`; the 6th guess is refused even with
 *   the correct code (PHY-76 #1).
 *
 * Why a separate INCR counter (not an `attempts` field in the record): the
 * former read-modify-write (`GET rec` → `rec.attempts += 1` → `SET rec`) had no
 * atomicity, so a flood of concurrent guesses all read the same low count
 * before any write-back and the cap could be raced past for the full 600 s TTL
 * — an unauthenticated brute-force account-takeover of the 10^6 code space.
 * `INCR` is atomic and evaluated FIRST, so Redis serializes the guesses and at
 * most CODE_MAX_ATTEMPTS of them are ever checked against a live code,
 * regardless of concurrency. IP/enumeration flooding is bounded separately by
 * the verify-side rate limit in login.verify.server.ts.
 */
import { createHash, randomInt } from 'node:crypto';
import { isIP } from 'node:net';
import { getRedis } from '@drobek/core';

export const CODE_TTL_S = 10 * 60;
export const CODE_MAX_ATTEMPTS = 5;
export const CODE_LENGTH = 6;

interface LoginCodeRecord {
  email: string;
  codeHash: string;
  ip?: string;
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function emailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

function codeRedisKey(email: string): string {
  return `drobek:otp:code:${emailHash(email)}`;
}

/** Sibling key holding the atomic guess counter for the code above. */
function attemptsRedisKey(email: string): string {
  return `drobek:otp:attempts:${emailHash(email)}`;
}

export function normalizeAuthEmail(input: string): string {
  return input.trim().toLowerCase();
}

/** Exactly 6 numeric digits (0-9), leading zeros allowed. */
export function generateLoginCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) out += String(randomInt(0, 10));
  return out;
}

export async function createEmailLoginCode(
  email: string,
  ip: string | undefined
): Promise<string> {
  const norm = normalizeAuthEmail(email);
  const code = generateLoginCode();
  const rec: LoginCodeRecord = {
    email: norm,
    codeHash: hashCode(code),
    ip,
  };
  const r = getRedis();
  // Clear any burned counter from a prior code FIRST, so the fresh code always
  // starts with a full guess budget (a leftover count >= max would otherwise
  // kill the new code on arrival).
  await r.del(attemptsRedisKey(norm));
  await r.set(codeRedisKey(norm), JSON.stringify(rec), 'EX', CODE_TTL_S);
  return code;
}

export async function consumeEmailLoginCode(
  email: string,
  code: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const norm = normalizeAuthEmail(email);
  const r = getRedis();
  const key = codeRedisKey(norm);
  const attemptsKey = attemptsRedisKey(norm);

  // Atomic guess counter FIRST, before the code is even read. `INCR` is atomic,
  // so Redis serializes concurrent guesses and hands each a distinct count —
  // only the first CODE_MAX_ATTEMPTS ever proceed to a comparison against a live
  // code. Everything past the cap is refused without evaluating a guess, which
  // is what defeats the concurrent brute-force (PHY-76 #1).
  const attempts = await r.incr(attemptsKey);
  if (attempts === 1) {
    // Bound the counter's lifetime to the code TTL (createEmailLoginCode also
    // clears it when a fresh code is issued).
    await r.pexpire(attemptsKey, CODE_TTL_S * 1000);
  }
  if (attempts > CODE_MAX_ATTEMPTS) {
    await r.del(key);
    return { ok: false, reason: 'too_many_attempts' };
  }

  const raw = await r.get(key);
  if (!raw) return { ok: false, reason: 'no_code' };

  let rec: LoginCodeRecord;
  try {
    rec = JSON.parse(raw) as LoginCodeRecord;
  } catch {
    await r.del(key);
    return { ok: false, reason: 'bad_record' };
  }

  if (hashCode(code.trim()) !== rec.codeHash) {
    if (attempts >= CODE_MAX_ATTEMPTS) {
      // Final allowed guess was wrong — invalidate the code entirely so the
      // next try fails even if it IS the correct code.
      await r.del(key);
      return { ok: false, reason: 'too_many_attempts' };
    }
    return { ok: false, reason: 'wrong_code' };
  }

  // Correct: single-use — drop the code and its spent counter.
  await r.del(key, attemptsKey);
  return { ok: true };
}

/**
 * How far the client-IP headers are trusted (`TRUST_PROXY`, M0-07):
 *
 * - `auto` (unset — the PHY-76 #4 behaviour): prefer `X-Real-IP`, fall back to
 *   the RIGHTMOST `X-Forwarded-For` hop. Right for an nginx front that sets
 *   `X-Real-IP $remote_addr` and appends to XFF.
 * - `x-real-ip`: drobek sits behind the bundled Caddy (or any proxy that
 *   OVERWRITES `X-Real-IP` with the TCP peer). Only `X-Real-IP` is read, it
 *   must be a literal IP address, and `X-Forwarded-For` is ignored entirely.
 */
export type TrustProxyMode = 'auto' | 'x-real-ip';

const TRUST_PROXY_MODES: readonly TrustProxyMode[] = ['auto', 'x-real-ip'];

/** The configured mode; null when TRUST_PROXY holds an unknown value. */
export function trustProxyMode(env: NodeJS.ProcessEnv = process.env): TrustProxyMode | null {
  const raw = env.TRUST_PROXY?.trim().toLowerCase();
  if (!raw) return 'auto';
  return (TRUST_PROXY_MODES as readonly string[]).includes(raw) ? (raw as TrustProxyMode) : null;
}

/** Startup check: a human-readable error, or null when TRUST_PROXY is valid. */
export function trustProxyConfigError(env: NodeJS.ProcessEnv = process.env): string | null {
  if (trustProxyMode(env) !== null) return null;
  return `drobek refuses to start: TRUST_PROXY must be one of ${TRUST_PROXY_MODES.join(', ')} (or unset).`;
}

/**
 * Best-effort client IP for per-IP rate limits. Trusts the reverse proxy, NOT
 * the client (PHY-76 #4):
 *
 * - Prefer `X-Real-IP`: prod nginx sets it to `$remote_addr` (the real TCP peer)
 *   and OVERWRITES any client-sent value, so it cannot be spoofed from outside.
 *   Trusting it also delegates the "which hop is real" decision to the proxy,
 *   which is the layer that actually knows the topology.
 * - Fallback `X-Forwarded-For`: take the RIGHTMOST hop, which the proxy APPENDS
 *   from the real socket (`$proxy_add_x_forwarded_for`). NEVER the leftmost —
 *   nginx prepends the client-sent chain there, so the head is attacker-chosen
 *   (the old code returned exactly that leftmost entry, voiding every per-IP
 *   limit via a spoofed header).
 *
 * With `TRUST_PROXY=x-real-ip` (behind the bundled Caddy, which sets
 * `header_up X-Real-IP {remote_host}`) ONLY X-Real-IP counts, and only when it
 * is a literal IP — the fallback chain is never consulted.
 *
 * With no proxy in front (direct exposure), no header is trustworthy and this
 * returns whatever is present — per-IP limits are inherently weak there; the
 * recommended deployment runs behind Caddy or nginx.
 */
export function getClientIp(
  request: Request,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const real = request.headers.get('x-real-ip')?.trim();
  if (trustProxyMode(env) === 'x-real-ip') {
    return real && isIP(real) !== 0 ? real : undefined;
  }
  if (real) return real;
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const hops = xff
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return undefined;
}
