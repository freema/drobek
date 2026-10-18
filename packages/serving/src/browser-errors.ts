/**
 * Browser errors of the preview: what the preview script beacons to
 * `POST /__drobek/preview/errors` on the preview and version hosts, checked
 * before anything is stored. The body is untrusted (any script on the app's
 * origin can post it), so every field is read on its own, capped and
 * redacted (e-mail addresses, tokens) and every other key is dropped. A page
 * URL keeps only its path; nothing about the visitor but the browser family
 * is kept. Pure — the Redis side is browser-errors.server.ts.
 */
import { createHash } from 'node:crypto';
import { redact } from '@drobek/insights';

/** Bytes of one beacon; a bigger body is dropped unread. */
export const MAX_ERRORS_BODY_BYTES = 16 * 1024;
/** Errors one beacon may carry (the rest is dropped). */
export const MAX_ERRORS_PER_BEACON = 10;
const MAX_ERROR_MESSAGE = 1024;
const MAX_ERROR_STACK = 4096;
const MAX_PATH = 512;
/** How often one error may be counted by one beacon. */
const MAX_COUNT = 1000;
const MAX_POSITION = 10_000_000;

export const DEFAULT_BROWSER_ERRORS_PER_IP_MINUTE = 30;
export const DEFAULT_BROWSER_ERRORS_MAX_PER_VERSION = 200;
export const DEFAULT_BROWSER_ERRORS_TTL_HOURS = 48;

export interface BrowserErrorLimits {
  /** Beacons one client IP may send to one app per minute; the rest are dropped. */
  perIpMinute: number;
  /** Distinct errors kept per version; new ones past it are dropped (counts of kept ones still go up). */
  maxPerVersion: number;
  /** How long a version's errors are kept after the last one arrived. */
  ttlHours: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** BROWSER_ERRORS_PER_IP_MINUTE / _MAX_PER_VERSION / _TTL_HOURS (the defaults when unset or not a positive integer). */
export function browserErrorLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): BrowserErrorLimits {
  return {
    perIpMinute: positiveInt(env.BROWSER_ERRORS_PER_IP_MINUTE, DEFAULT_BROWSER_ERRORS_PER_IP_MINUTE),
    maxPerVersion: positiveInt(env.BROWSER_ERRORS_MAX_PER_VERSION, DEFAULT_BROWSER_ERRORS_MAX_PER_VERSION),
    ttlHours: positiveInt(env.BROWSER_ERRORS_TTL_HOURS, DEFAULT_BROWSER_ERRORS_TTL_HOURS),
  };
}

/** `error` = uncaught, `unhandledrejection` = a rejected promise nobody handled, `console` = console.error with an Error. */
export type BrowserErrorType = 'error' | 'unhandledrejection' | 'console';
const TYPES: readonly BrowserErrorType[] = ['error', 'unhandledrejection', 'console'];

/** The browser family (never a version or the OS). */
export type BrowserFamily = 'chrome' | 'edge' | 'firefox' | 'safari' | 'other';
const FAMILIES: readonly BrowserFamily[] = ['chrome', 'edge', 'firefox', 'safari', 'other'];

/** One reported error, checked and capped. */
interface BrowserErrorReport {
  /** sha256 (16 hex) of message + stack: the same error counts up instead of adding a row. */
  key: string;
  type: BrowserErrorType;
  message: string;
  stack: string | null;
  /** The script the error came from (path only, or origin + path of another origin), its line and column. */
  source: string | null;
  line: number | null;
  col: number | null;
  /** The page's path (no query string or fragment). */
  path: string;
  /** Occurrences this beacon reports (the script sends one error once a minute with its count). */
  count: number;
}

export interface BrowserErrorBatch {
  /** The version the page says it was served from (null = none or not a positive integer). */
  version: number | null;
  ua: BrowserFamily;
  errors: BrowserErrorReport[];
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function int(v: unknown, max: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null;
}

/** `text` redacted and cut to `max` characters. */
function capped(text: string, max: number): string {
  const r = redact(text);
  return r.length > max ? r.slice(0, max) : r;
}

/** A page path without its query string or fragment ('/' when unusable). */
function pagePath(v: unknown): string {
  const raw = str(v);
  if (!raw || !raw.startsWith('/')) return '/';
  const cut = raw.split(/[?#]/, 1)[0];
  return capped(cut, MAX_PATH);
}

/** A script address: path only on the page's own origin, else origin + path; never a query or fragment. */
function scriptSource(v: unknown): string | null {
  const raw = str(v);
  if (!raw) return null;
  if (raw.startsWith('/')) return capped(raw.split(/[?#]/, 1)[0], MAX_PATH);
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return capped(`${u.origin}${u.pathname}`, MAX_PATH);
  } catch {
    return null;
  }
}

function errorKey(message: string, stack: string | null): string {
  return createHash('sha256').update(`${message}\n${stack ?? ''}`).digest('hex').slice(0, 16);
}

/** The checked batch of an untrusted beacon body (already JSON-parsed); null when it carries no usable error. */
export function parseBrowserErrors(body: unknown): BrowserErrorBatch | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.errors)) return null;
  const version = int(b.version, 2_147_483_647);
  const ua = FAMILIES.find((f) => f === b.ua) ?? 'other';
  const errors: BrowserErrorReport[] = [];
  for (const raw of b.errors.slice(0, MAX_ERRORS_PER_BEACON)) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const text = str(e.message);
    if (!text || text.trim() === '') continue;
    const message = capped(text, MAX_ERROR_MESSAGE);
    const stackRaw = str(e.stack);
    const stack = stackRaw ? capped(stackRaw, MAX_ERROR_STACK) : null;
    const count = int(e.count, MAX_COUNT);
    errors.push({
      key: errorKey(message, stack),
      type: TYPES.find((t) => t === e.type) ?? 'error',
      message,
      stack,
      source: scriptSource(e.source),
      line: int(e.line, MAX_POSITION),
      col: int(e.col, MAX_POSITION),
      path: pagePath(e.path),
      count: count && count > 0 ? count : 1,
    });
  }
  return errors.length > 0 ? { version: version && version > 0 ? version : null, ua, errors } : null;
}
