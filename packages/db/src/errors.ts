/**
 * Database errors, read the one safe way (NSO-333).
 *
 * The shape of a failed query depends on the driver and the drizzle version:
 * postgres.js throws a `PostgresError` (`code`, `constraint_name`,
 * `table_name`), PGlite a `DatabaseError` (`code`, `constraint`, `table`), and
 * drizzle-orm ≥ 0.44 wraps either in a `DrizzleQueryError` whose own `code` is
 * undefined (the driver error is its `cause`) and whose message is
 * `Failed query: <sql>\nparams: <bound values>`.
 *
 * Neither message is log-safe: the drizzle one carries the bound parameters
 * (end-user e-mails, token hashes) and a Postgres message can quote the input
 * (`invalid input syntax for type uuid: "<value>"`, `detail`: `Key (email)=(…)`).
 * So code never reads `err.code` / `err.message` of a query error itself:
 * `pgErrorCode` / `isUniqueViolation` for decisions, `dbErrorForLog` for logs.
 */

/** A Postgres SQLSTATE: two-character class + three characters. */
const SQLSTATE = /^(?:[0-9][0-9A-Z]|F0|HV|P0|XX)[0-9A-Z]{3}$/;

/** How deep `cause` chains are followed (a wrapper of a wrapper is plenty). */
const MAX_DEPTH = 5;

type ErrorLike = Record<string, unknown>;

function asObject(v: unknown): ErrorLike | null {
  return typeof v === 'object' && v !== null ? (v as ErrorLike) : null;
}

/** `err` and its `cause` chain, outermost first. */
function chain(err: unknown): ErrorLike[] {
  const out: ErrorLike[] = [];
  let cur = asObject(err);
  while (cur && out.length < MAX_DEPTH && !out.includes(cur)) {
    out.push(cur);
    cur = asObject(cur.cause);
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** drizzle-orm ≥ 0.44 wraps every driver error in one of these. */
function isDrizzleQueryError(e: ErrorLike): boolean {
  return e.name === 'DrizzleQueryError' || (typeof e.query === 'string' && Array.isArray(e.params));
}

/** A server-side Postgres error (postgres.js `PostgresError`, PGlite `DatabaseError`). */
function isServerError(e: ErrorLike): boolean {
  return typeof e.code === 'string' && SQLSTATE.test(e.code) && (typeof e.severity === 'string' || e.name === 'PostgresError');
}

/**
 * The Postgres SQLSTATE of a failed query (`'23505'`, `'40001'`, …), wherever
 * the driver / drizzle version put it; undefined for anything else.
 */
export function pgErrorCode(err: unknown): string | undefined {
  for (const e of chain(err)) {
    if (isServerError(e)) return e.code as string;
  }
  return undefined;
}

/** A unique / primary-key violation (SQLSTATE 23505). */
export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23505';
}

/** The SQLSTATE (or driver code), constraint and table of a DB error; null when `err` is not one. */
function dbErrorSummary(err: unknown): string | null {
  const links = chain(err);
  const server = links.find(isServerError);
  if (!server && !links.some(isDrizzleQueryError) && !links.some((e) => e.name === 'PostgresError')) return null;
  const at = server ?? links[links.length - 1];
  // A connection-level failure under a DrizzleQueryError carries a Node code
  // (ECONNREFUSED, CONNECTION_ENDED) and no SQLSTATE.
  const code = str(at.code) && /^[A-Z0-9_]{1,40}$/.test(at.code as string) ? (at.code as string) : 'unknown';
  const constraint = str(at.constraint_name) ?? str(at.constraint);
  const table = str(at.table_name) ?? str(at.table);
  const parts = [constraint && `constraint ${constraint}`, table && `table ${table}`].filter(Boolean);
  return `db error ${code}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

/** Stack frames only — the first line(s) of `stack` repeat the message. */
function framesOf(err: unknown): string {
  const stack = asObject(err)?.stack;
  if (typeof stack !== 'string') return '';
  return stack
    .split('\n')
    .filter((l) => /^\s+at /.test(l))
    .join('\n');
}

/**
 * Log-safe text for any caught error. A DB error (anywhere in the `cause`
 * chain) becomes `db error <code> (constraint …, table …)` — never its
 * message, detail, SQL or bound parameters; with `stack` its frames follow.
 * Any other error keeps its message (or its stack with `stack: true`).
 */
export function dbErrorForLog(err: unknown, opts: { stack?: boolean } = {}): string {
  const summary = dbErrorSummary(err);
  if (summary !== null) {
    const frames = opts.stack ? framesOf(err) : '';
    return frames ? `${summary}\n${frames}` : summary;
  }
  const e = asObject(err);
  if (opts.stack && typeof e?.stack === 'string') return e.stack;
  if (typeof e?.message === 'string') return e.message;
  return String(err);
}
