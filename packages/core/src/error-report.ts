/**
 * Where the server's errors go besides stdout: an error reporter a platform
 * module contributes to the core-hosted `errors.reporter` slot, chosen with
 * ERROR_REPORTER=<its id> (unset → logs only). The module runtime installs the
 * selected reporter at start, process-wide on globalThis (the dev server's
 * Vite-loaded copy of this package sees it too), with the values of the env
 * vars it declares in `secrets`.
 *
 * `reportError` is called at the server's central error points (a 5xx of the
 * dashboard or Express, a module route that throws, a failed module job, a
 * failed e-mail send, a start-up failure once the reporter is up). It never
 * throws and never holds up the caller: the event is built from an allow-list
 * (no request bodies, headers, cookies or query strings), e-mail addresses,
 * token-shaped strings and every known secret value are redacted, identical
 * events are sent once per minute, at most ERROR_REPORTER_MAX_PER_MINUTE go
 * out per minute, and each delivery is cut off after
 * ERROR_REPORTER_TIMEOUT_MS. A failed delivery is logged (once per minute)
 * and dropped.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { dbErrorForLog } from '@drobek/db';
import { createConsoleLogger, type Logger } from './logger.js';
import { SECRET_ENV_VARS } from './secrets-config.js';

/** The reporter API this server implements (a contribution may declare it as `apiVersion`). */
export const ERROR_REPORTER_API_VERSION = 1;

/** Reporter ids: lowercase letters and digits, 2–16 characters (the value of ERROR_REPORTER). */
export const ERROR_REPORTER_ID_RE = /^[a-z][a-z0-9]{1,15}$/;

export const ERROR_REPORTER_TIMEOUT_DEFAULT_MS = 5_000;
export const ERROR_REPORTER_MAX_PER_MINUTE_DEFAULT = 60;
const TIMEOUT_MIN_MS = 100;
const TIMEOUT_MAX_MS = 60_000;
const PER_MINUTE_MIN = 1;
const PER_MINUTE_MAX = 10_000;
const WINDOW_MS = 60_000;

/** Where in the server the error happened. */
export type ErrorReportKind = 'http' | 'module_route' | 'module_job' | 'startup' | 'email';

/** What is known about the place of the error — ids and names only, never request data. */
export interface ErrorReportContext {
  kind: ErrorReportKind;
  /** The request path without its query string; long opaque segments (tokens, ids) read `:param`. */
  route?: string;
  method?: string;
  status?: number;
  module?: string;
  job?: string;
  appId?: string;
  workspaceId?: string;
  requestId?: string;
}

/** One error as a reporter receives it. */
export interface ErrorReportEvent {
  level: 'error' | 'fatal';
  /** What failed, in the server's words (e.g. `module job failed`). */
  message: string;
  /** The thrown error: its name, message and stack, redacted (a database error reads `db error <code> (…)`). */
  error?: { name: string; message: string; stack?: string };
  context: ErrorReportContext;
  /** DROBEK_VERSION, else GIT_SHA, else `dev`. */
  release: string;
  /** NODE_ENV (`development` when unset). */
  environment: string;
  /** ISO 8601. */
  timestamp: string;
  /** Stable for the same kind of error at the same place: group by it. */
  fingerprint: string;
}

export interface ErrorReporterContext {
  /** The values of the env vars the reporter declared in `secrets` (all set: the server refuses to start otherwise). Never log them. */
  secrets: Readonly<Record<string, string>>;
  /** Aborted when the delivery runs past ERROR_REPORTER_TIMEOUT_MS: pass it to `fetch`. */
  signal: AbortSignal;
}

/**
 * A module's error reporter (the `errors.reporter` slot). `report` is called
 * unbound for every admitted event; whatever it throws is logged and dropped.
 */
export interface ErrorReporter {
  apiVersion?: typeof ERROR_REPORTER_API_VERSION;
  /** `ERROR_REPORTER_ID_RE`; unique within the slot. */
  id: string;
  /** The service's name for logs and docs (1–40 characters). */
  label: string;
  /** The operator env vars the reporter needs (UPPER_SNAKE), e.g. `['WEBHOOK_TOKEN']`. */
  secrets?: string[];
  report(event: ErrorReportEvent, ctx: ErrorReporterContext): Promise<void> | void;
}

/** What a caller hands to `reportError`. */
export interface ErrorReportInput {
  level?: 'error' | 'fatal';
  message: string;
  error?: unknown;
  context: ErrorReportContext;
}

interface Window {
  start: number;
  sent: number;
  seen: Set<string>;
  overLogged: boolean;
  failureLogged: boolean;
}

interface Installed {
  reporter: ErrorReporter;
  secrets: Readonly<Record<string, string>>;
  /** Every value redacted from an event: the reporter's secrets and the server's own. */
  redactValues: string[];
  timeoutMs: number;
  maxPerMinute: number;
  release: string;
  environment: string;
  log: Logger;
  window: Window;
}

const KEY = Symbol.for('drobek.core.errorReporter');
type Holder = { [KEY]?: Installed };
const delivering = new AsyncLocalStorage<true>();

function intFromEnv(raw: string | undefined, def: number, min: number, max: number): number | null {
  const v = raw?.trim();
  if (!v) return def;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** ERROR_REPORTER trimmed and lower-cased, or null when unset (logs only). */
export function errorReporterId(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.ERROR_REPORTER?.trim().toLowerCase() || null;
}

/** ERROR_REPORTER_TIMEOUT_MS, or null when it is set but not an integer in range. */
function errorReporterTimeoutMs(env: NodeJS.ProcessEnv = process.env): number | null {
  return intFromEnv(env.ERROR_REPORTER_TIMEOUT_MS, ERROR_REPORTER_TIMEOUT_DEFAULT_MS, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS);
}

/** ERROR_REPORTER_MAX_PER_MINUTE, or null when it is set but not an integer in range. */
function errorReporterMaxPerMinute(env: NodeJS.ProcessEnv = process.env): number | null {
  return intFromEnv(env.ERROR_REPORTER_MAX_PER_MINUTE, ERROR_REPORTER_MAX_PER_MINUTE_DEFAULT, PER_MINUTE_MIN, PER_MINUTE_MAX);
}

/** A start-up refusal for the ERROR_REPORTER_* settings, or null. Names variables only — never a value. */
export function errorReporterConfigError(env: NodeJS.ProcessEnv = process.env): string | null {
  const id = errorReporterId(env);
  if (id !== null && !ERROR_REPORTER_ID_RE.test(id)) {
    return 'ERROR_REPORTER must be empty (errors are only logged) or the id of a module error reporter (2–16 lowercase letters and digits).';
  }
  if (errorReporterTimeoutMs(env) === null) {
    return `ERROR_REPORTER_TIMEOUT_MS must be milliseconds between ${TIMEOUT_MIN_MS} and ${TIMEOUT_MAX_MS} (default ${ERROR_REPORTER_TIMEOUT_DEFAULT_MS}).`;
  }
  if (errorReporterMaxPerMinute(env) === null) {
    return `ERROR_REPORTER_MAX_PER_MINUTE must be an integer between ${PER_MINUTE_MIN} and ${PER_MINUTE_MAX} (default ${ERROR_REPORTER_MAX_PER_MINUTE_DEFAULT}).`;
  }
  return null;
}

/** The env vars of `reporter.secrets` that are unset or blank in `env` (names only). */
export function missingReporterSecrets(reporter: Pick<ErrorReporter, 'secrets'>, env: NodeJS.ProcessEnv = process.env): string[] {
  return (reporter.secrets ?? []).filter((name) => !env[name]?.trim());
}

/**
 * Make `reporter` the server's error reporter (null uninstalls). Reads its
 * secrets, the timeout and the per-minute cap from `env` now; throws when
 * one is missing or invalid.
 */
export function installErrorReporter(reporter: ErrorReporter | null, env: NodeJS.ProcessEnv = process.env, log?: Logger): void {
  const g = globalThis as Holder;
  if (!reporter) {
    delete g[KEY];
    return;
  }
  const missing = missingReporterSecrets(reporter, env);
  if (missing.length > 0) throw new Error(`the error reporter "${reporter.id}" needs ${missing.join(', ')} in the server env`);
  const problem = errorReporterConfigError({ ...env, ERROR_REPORTER: undefined });
  if (problem) throw new Error(problem);
  const secrets = Object.freeze(Object.fromEntries((reporter.secrets ?? []).map((name) => [name, env[name]!.trim()])));
  const serverSecrets = SECRET_ENV_VARS.map((name) => env[name]?.trim() ?? '');
  const redactValues = [...new Set([...Object.values(secrets), ...serverSecrets])].filter((v) => v.length >= 6).sort((a, b) => b.length - a.length);
  g[KEY] = {
    reporter,
    secrets,
    redactValues,
    timeoutMs: errorReporterTimeoutMs(env)!,
    maxPerMinute: errorReporterMaxPerMinute(env)!,
    release: env.DROBEK_VERSION?.trim() || env.GIT_SHA?.trim() || 'dev',
    environment: env.NODE_ENV?.trim() || 'development',
    log: log ?? createConsoleLogger('errors'),
    window: { start: 0, sent: 0, seen: new Set(), overLogged: false, failureLogged: false },
  };
}

/** The id of the installed error reporter, or null. */
export function installedErrorReporterId(): string | null {
  return (globalThis as Holder)[KEY]?.reporter.id ?? null;
}

const REDACTED = '[redacted]';
const MAX_MESSAGE = 1_000;
const MAX_STACK = 8_000;
const MAX_FIELD = 200;

/** `text` without e-mail addresses, bearer / JWT tokens, `key=value` secrets, long opaque tokens and any of `values`. */
export function redactForReport(text: string, values: readonly string[] = []): string {
  let s = text;
  for (const v of values) if (v) s = s.split(v).join(REDACTED);
  s = s.replace(/[^\s@<>,;"'()[\]\\:/]+@[^\s@<>,;"'()[\]\\:/]+\.[A-Za-z]{2,}/g, '[email]');
  s = s.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED);
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`);
  s = s.replace(
    /((?:cookie|authorization|access[_-]?token|refresh[_-]?token|token|api[_-]?key|secret|password|passwd|session|sid)\s*[:=]\s*)("?)([^\s;"'&,]+)\2/gi,
    (_m, key: string) => `${key}${REDACTED}`
  );
  return s.replace(/\b[A-Za-z0-9_-]{32,}\b/g, REDACTED);
}

/** A request path for a report: no query string or fragment; a long opaque segment (token, id) reads `:param`. */
export function routeForReport(path: string): string {
  const bare = path.split(/[?#]/, 1)[0] ?? '';
  return bare
    .split('/')
    .map((seg) => (seg.length >= 20 || (seg.length >= 12 && /\d/.test(seg) && /^[A-Za-z0-9_~.-]+$/.test(seg)) ? ':param' : seg))
    .join('/')
    .slice(0, MAX_FIELD);
}

function cap(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function errorFields(err: unknown, values: readonly string[]): ErrorReportEvent['error'] {
  if (err === undefined || err === null) return undefined;
  const e = typeof err === 'object' ? (err as { name?: unknown; message?: unknown; stack?: unknown }) : null;
  const safe = dbErrorForLog(err);
  const isDb = e !== null && safe.startsWith('db error ') && safe !== e.message;
  const rawName = e?.name;
  const name = isDb ? 'DatabaseError' : typeof rawName === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(rawName) ? rawName : 'Error';
  const message = isDb ? safe : typeof e?.message === 'string' ? e.message : String(err);
  const full = isDb ? dbErrorForLog(err, { stack: true }) : typeof e?.stack === 'string' ? e.stack : '';
  const stack = full ? cap(redactForReport(full, values), MAX_STACK) : undefined;
  return { name, message: cap(redactForReport(message, values), MAX_MESSAGE), ...(stack ? { stack } : {}) };
}

function contextFields(c: ErrorReportContext, values: readonly string[]): ErrorReportContext {
  const field = (v: unknown) => (typeof v === 'string' && v ? cap(redactForReport(v, values), MAX_FIELD) : undefined);
  const out: ErrorReportContext = { kind: c.kind };
  if (c.route) out.route = redactForReport(routeForReport(c.route), values);
  const method = field(c.method)?.toUpperCase();
  if (method && /^[A-Z]{1,16}$/.test(method)) out.method = method;
  if (Number.isInteger(c.status)) out.status = c.status;
  for (const k of ['module', 'job', 'appId', 'workspaceId', 'requestId'] as const) {
    const v = field(c[k]);
    if (v) out[k] = v;
  }
  return out;
}

function fingerprintOf(event: Omit<ErrorReportEvent, 'fingerprint'>): string {
  const { kind, module, job, route, method } = event.context;
  const what = (event.error?.message ?? event.message).split('\n', 1)[0]!.replace(/\d+/g, '0');
  return createHash('sha256')
    .update(JSON.stringify([kind, module, job, method, route, event.error?.name, event.message, what]))
    .digest('hex')
    .slice(0, 32);
}

/** Whether the event may go out now: identical ones once per minute, at most the cap per minute. */
function admit(inst: Installed, fingerprint: string, now: number): boolean {
  const w = inst.window;
  if (now - w.start >= WINDOW_MS) Object.assign(w, { start: now, sent: 0, seen: new Set(), overLogged: false, failureLogged: false });
  if (w.seen.has(fingerprint)) return false;
  if (w.sent >= inst.maxPerMinute) {
    if (!w.overLogged) {
      w.overLogged = true;
      inst.log.warn('error reports over ERROR_REPORTER_MAX_PER_MINUTE — the rest of this minute is dropped (still logged)', {
        reporter: inst.reporter.id,
        max_per_minute: inst.maxPerMinute,
      });
    }
    return false;
  }
  w.seen.add(fingerprint);
  w.sent += 1;
  return true;
}

function logFailure(inst: Installed, detail: string): void {
  if (inst.window.failureLogged) return;
  inst.window.failureLogged = true;
  inst.log.warn('the error reporter failed — the report is dropped', { reporter: inst.reporter.id, error: cap(redactForReport(detail, inst.redactValues), 300) });
}

async function deliver(inst: Installed, event: ErrorReportEvent): Promise<void> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('timeout');
    }, inst.timeoutMs);
    timer.unref?.();
  });
  try {
    const run = delivering.run(true, () => Promise.resolve().then(() => inst.reporter.report(event, { secrets: inst.secrets, signal: controller.signal })));
    const outcome = await Promise.race([run.then(() => 'ok' as const), timeout]);
    if (outcome === 'timeout') {
      run.catch(() => undefined);
      logFailure(inst, `no answer within ${inst.timeoutMs} ms (ERROR_REPORTER_TIMEOUT_MS)`);
    }
  } catch (err) {
    logFailure(inst, dbErrorForLog(err));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hand an error to the installed reporter. Never throws; resolves once the
 * report was delivered, dropped or timed out (callers `void` it — only a
 * start-up failure awaits it before the process exits). A no-op without a
 * reporter and inside a reporter's own delivery.
 */
export function reportError(input: ErrorReportInput): Promise<void> {
  const inst = (globalThis as Holder)[KEY];
  if (!inst || delivering.getStore()) return Promise.resolve();
  try {
    const values = inst.redactValues;
    const error = errorFields(input.error, values);
    const base: Omit<ErrorReportEvent, 'fingerprint'> = {
      level: input.level === 'fatal' ? 'fatal' : 'error',
      message: cap(redactForReport(input.message, values), MAX_MESSAGE),
      ...(error ? { error } : {}),
      context: contextFields(input.context, values),
      release: inst.release,
      environment: inst.environment,
      timestamp: new Date().toISOString(),
    };
    const event: ErrorReportEvent = { ...base, fingerprint: fingerprintOf(base) };
    if (!admit(inst, event.fingerprint, Date.now())) return Promise.resolve();
    return deliver(inst, event);
  } catch (err) {
    logFailure(inst, dbErrorForLog(err));
    return Promise.resolve();
  }
}

/** @internal test helper */
export function resetErrorReporterForTests(): void {
  delete (globalThis as Holder)[KEY];
}
