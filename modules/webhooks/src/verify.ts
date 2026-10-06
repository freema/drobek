/**
 * Verifying one delivery against the endpoint's secret, over the RAW body
 * (before anything parses it). Every comparison is constant-time. Pure:
 * nothing here logs, and no result carries the secret, a signature or the
 * body.
 *
 *   hmac-sha256     — HMAC-SHA256(secret, body) in `header` (default
 *                     X-Webhook-Signature): hex, `sha256=<hex>` or base64.
 *   stripe          — `Stripe-Signature: t=<unix>,v1=<hex>[,v1=…]` over
 *                     `<t>.<body>`; `t` within TIMESTAMP_TOLERANCE_SEC of now.
 *   github          — `X-Hub-Signature-256: sha256=<hex>` over the body.
 *   none-with-token — the secret itself in `header` (default
 *                     X-Webhook-Token) or the `token` query parameter.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { VerifyScheme } from './config.js';

/** How far a signed timestamp may be from now (replay protection of the schemes that sign one). */
export const TIMESTAMP_TOLERANCE_SEC = 300;

const DEFAULT_SIGNATURE_HEADER = 'x-webhook-signature';
const DEFAULT_TOKEN_HEADER = 'x-webhook-token';
const DEFAULT_ID_HEADER = 'webhook-id';

type VerifyFailure = 'missing_signature' | 'bad_signature' | 'timestamp_out_of_tolerance';
export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

export interface VerifyInput {
  scheme: VerifyScheme;
  secret: string;
  body: Buffer;
  header(name: string): string | null;
  /** The raw query string (none-with-token's `token`). */
  query: string;
  /** The endpoint's `header` (hmac-sha256 / none-with-token). */
  headerName?: string;
  /** Seconds since the epoch (tests). */
  now?: number;
}

function hmac(secret: string, ...parts: (string | Buffer)[]): Buffer {
  const h = createHmac('sha256', secret);
  for (const p of parts) h.update(p);
  return h.digest();
}

/** Constant-time equality of two byte strings of any length. */
function same(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Constant-time equality of two texts (compared as SHA-256 digests, so their lengths do not leak). */
function sameText(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** A signature as bytes: hex (64 digits, optionally `sha256=`) or base64 (32 bytes); null when it is neither. */
export function signatureBytes(raw: string): Buffer | null {
  const v = raw.trim().replace(/^sha256=/i, '');
  if (/^[0-9a-f]{64}$/i.test(v)) return Buffer.from(v, 'hex');
  if (/^[A-Za-z0-9+/]{43}=?$/.test(v) || /^[A-Za-z0-9_-]{43}$/.test(v)) {
    const b = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return b.length === 32 ? b : null;
  }
  return null;
}

function verifyHmac(input: VerifyInput, headerName: string, prefixRequired: boolean): VerifyResult {
  const raw = input.header(headerName.toLowerCase());
  if (!raw) return { ok: false, reason: 'missing_signature' };
  if (prefixRequired && !/^sha256=/i.test(raw.trim())) return { ok: false, reason: 'bad_signature' };
  const given = signatureBytes(raw);
  if (!given) return { ok: false, reason: 'bad_signature' };
  return same(given, hmac(input.secret, input.body)) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

function verifyStripe(input: VerifyInput): VerifyResult {
  const raw = input.header('stripe-signature');
  if (!raw) return { ok: false, reason: 'missing_signature' };
  let t: string | null = null;
  const v1: Buffer[] = [];
  for (const part of raw.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't' && /^\d{1,12}$/.test(v)) t = v;
    else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) v1.push(Buffer.from(v, 'hex'));
  }
  if (t === null || v1.length === 0) return { ok: false, reason: 'missing_signature' };
  const expected = hmac(input.secret, `${t}.`, input.body);
  let match = false;
  for (const sig of v1) if (same(sig, expected)) match = true;
  if (!match) return { ok: false, reason: 'bad_signature' };
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(t)) > TIMESTAMP_TOLERANCE_SEC) return { ok: false, reason: 'timestamp_out_of_tolerance' };
  return { ok: true };
}

function verifyToken(input: VerifyInput): VerifyResult {
  const fromHeader = input.header((input.headerName ?? DEFAULT_TOKEN_HEADER).toLowerCase());
  const fromQuery = new URLSearchParams(input.query).get('token');
  const token = fromHeader ?? fromQuery;
  if (!token) return { ok: false, reason: 'missing_signature' };
  return sameText(token.trim(), input.secret) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

/** Verify one delivery by the endpoint's scheme. */
export function verifyDelivery(input: VerifyInput): VerifyResult {
  switch (input.scheme) {
    case 'hmac-sha256':
      return verifyHmac(input, input.headerName ?? DEFAULT_SIGNATURE_HEADER, false);
    case 'github':
      return verifyHmac(input, 'x-hub-signature-256', true);
    case 'stripe':
      return verifyStripe(input);
    case 'none-with-token':
      return verifyToken(input);
    default:
      return { ok: false, reason: 'bad_signature' };
  }
}

const MAX_EVENT_ID = 200;
const MAX_EVENT_TYPE = 100;

/** A sender-supplied short text: printable ASCII only, capped; null when empty or anything else. */
function shortText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 && t.length <= max && /^[\x21-\x7e][\x20-\x7e]*$/.test(t) ? t : null;
}

function field(payload: unknown, key: string): unknown {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>)[key] : undefined;
}

/** The sender's event id (dedupe) and event type of a verified delivery, when it carries them. */
export function eventFacts(input: {
  scheme: VerifyScheme;
  header(name: string): string | null;
  idHeader?: string;
  payload: unknown;
}): { id: string | null; type: string | null } {
  if (input.scheme === 'github') {
    return { id: shortText(input.header('x-github-delivery'), MAX_EVENT_ID), type: shortText(input.header('x-github-event'), MAX_EVENT_TYPE) };
  }
  if (input.scheme === 'stripe') {
    return { id: shortText(field(input.payload, 'id'), MAX_EVENT_ID), type: shortText(field(input.payload, 'type'), MAX_EVENT_TYPE) };
  }
  return {
    id: shortText(input.header((input.idHeader ?? DEFAULT_ID_HEADER).toLowerCase()), MAX_EVENT_ID),
    type: shortText(field(input.payload, 'type'), MAX_EVENT_TYPE) ?? shortText(field(input.payload, 'event'), MAX_EVENT_TYPE),
  };
}

/** The body as the record's `payload`: JSON parsed, a form body as its fields, anything else as UTF-8 text. */
export function payloadOf(body: Buffer, contentType: string | null): unknown {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  const text = body.toString('utf8');
  if (type === 'application/x-www-form-urlencoded') {
    const out = new Map<string, string>();
    for (const [k, v] of new URLSearchParams(text)) if (!out.has(k) && !k.startsWith('_')) out.set(k, v);
    return Object.fromEntries(out);
  }
  if (type === '' || type === 'application/json' || type.endsWith('+json') || type === 'text/plain') {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}
