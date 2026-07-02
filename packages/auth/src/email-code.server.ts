/**
 * Email magic-code auth — code create/consume (ported from puls, U2 deltas):
 * - 6-digit NUMERIC code (crypto randomInt per digit, leading zeros allowed).
 * - Stored as SHA-256 hex in `drobek:otp:code:<sha256(email)>`, TTL 600 s.
 * - Max 5 wrong attempts, then the record is DELETED — the 6th attempt fails
 *   even with the correct code.
 */
import { createHash, randomInt } from 'node:crypto';
import { getRedis } from '@drobek/core';

export const CODE_TTL_S = 10 * 60;
export const CODE_MAX_ATTEMPTS = 5;
export const CODE_LENGTH = 6;

interface LoginCodeRecord {
  email: string;
  codeHash: string;
  attempts: number;
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
    attempts: 0,
    ip,
  };
  await getRedis().set(
    codeRedisKey(norm),
    JSON.stringify(rec),
    'EX',
    CODE_TTL_S
  );
  return code;
}

export async function consumeEmailLoginCode(
  email: string,
  code: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const norm = normalizeAuthEmail(email);
  const r = getRedis();
  const key = codeRedisKey(norm);
  const raw = await r.get(key);
  if (!raw) return { ok: false, reason: 'no_code' };

  let rec: LoginCodeRecord;
  try {
    rec = JSON.parse(raw) as LoginCodeRecord;
  } catch {
    await r.del(key);
    return { ok: false, reason: 'bad_record' };
  }

  // Defensive: a record that already burned its attempts is dead.
  if (rec.attempts >= CODE_MAX_ATTEMPTS) {
    await r.del(key);
    return { ok: false, reason: 'too_many_attempts' };
  }

  if (hashCode(code.trim()) !== rec.codeHash) {
    rec.attempts += 1;
    if (rec.attempts >= CODE_MAX_ATTEMPTS) {
      // 5th wrong attempt invalidates the code entirely — the next try fails
      // with `no_code` even when it IS the correct code.
      await r.del(key);
      return { ok: false, reason: 'too_many_attempts' };
    }
    const ttl = await r.ttl(key);
    await r.set(key, JSON.stringify(rec), 'EX', ttl > 0 ? ttl : CODE_TTL_S);
    return { ok: false, reason: 'wrong_code' };
  }

  await r.del(key);
  return { ok: true };
}

export function getClientIp(request: Request): string | undefined {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim();
  const real = request.headers.get('x-real-ip');
  if (real) return real.trim();
  return undefined;
}
