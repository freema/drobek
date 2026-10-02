import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type DB = PostgresJsDatabase<typeof schema>;

/**
 * The server's database connections: two lazily opened postgres.js pools.
 *
 * - The request pool: every query of a request (dashboard, MCP, app hosts,
 *   module routes). Each connection is opened with `statement_timeout`
 *   (DB_STATEMENT_TIMEOUT_MS) and `lock_timeout` (DB_LOCK_TIMEOUT_MS), so a
 *   stuck query or a long wait for a row / advisory lock ends with an error
 *   instead of holding a connection every other request queues behind.
 * - The background-job pool: every query made inside `runAsJob` (the
 *   in-process jobs started by the server). Same size and lock timeout, no
 *   statement timeout (a sweep may legitimately run longer than a request),
 *   idle connections closed after a minute.
 *
 * Migrations open one connection of their own without either timeout
 * (`migrate.ts`). A value of 0 sends no setting: the database's own applies.
 *
 * The pools and the job scope live on globalThis: the dashboard's server
 * build bundles its own copy of this package, and it shares them, so
 * DB_POOL_MAX bounds the whole process.
 */

export const DB_POOL_MAX_DEFAULT = 20;
export const DB_STATEMENT_TIMEOUT_DEFAULT_MS = 30_000;
export const DB_LOCK_TIMEOUT_DEFAULT_MS = 10_000;
const POOL_MAX_LIMIT = 200;
const TIMEOUT_MIN_MS = 100;
const TIMEOUT_MAX_MS = 3_600_000;
const CONNECT_TIMEOUT_S = 5;
const JOB_POOL_IDLE_TIMEOUT_S = 60;

export interface DbPoolSettings {
  /** Connections per pool (DB_POOL_MAX). */
  max: number;
  /** DB_STATEMENT_TIMEOUT_MS of the request pool; 0 = none set. */
  statementTimeoutMs: number;
  /** DB_LOCK_TIMEOUT_MS of both pools; 0 = none set. */
  lockTimeoutMs: number;
}

export type DbPool = 'request' | 'job';

function intFromEnv(raw: string | undefined, def: number, min: number, max: number, zeroAllowed: boolean): number | null {
  const v = raw?.trim();
  if (!v) return def;
  const n = Number(v);
  if (!Number.isInteger(n)) return null;
  if (n === 0 && zeroAllowed) return 0;
  return n >= min && n <= max ? n : null;
}

const poolMax = (env: NodeJS.ProcessEnv) => intFromEnv(env.DB_POOL_MAX, DB_POOL_MAX_DEFAULT, 1, POOL_MAX_LIMIT, false);
const statementTimeout = (env: NodeJS.ProcessEnv) =>
  intFromEnv(env.DB_STATEMENT_TIMEOUT_MS, DB_STATEMENT_TIMEOUT_DEFAULT_MS, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS, true);
const lockTimeout = (env: NodeJS.ProcessEnv) => intFromEnv(env.DB_LOCK_TIMEOUT_MS, DB_LOCK_TIMEOUT_DEFAULT_MS, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS, true);

/** A start-up refusal for DB_POOL_MAX / DB_STATEMENT_TIMEOUT_MS / DB_LOCK_TIMEOUT_MS, or null. */
export function dbConfigError(env: NodeJS.ProcessEnv = process.env): string | null {
  if (poolMax(env) === null) return `DB_POOL_MAX must be an integer between 1 and ${POOL_MAX_LIMIT} (default ${DB_POOL_MAX_DEFAULT}).`;
  if (statementTimeout(env) === null) {
    return `DB_STATEMENT_TIMEOUT_MS must be 0 (none) or milliseconds between ${TIMEOUT_MIN_MS} and ${TIMEOUT_MAX_MS} (default ${DB_STATEMENT_TIMEOUT_DEFAULT_MS}).`;
  }
  if (lockTimeout(env) === null) {
    return `DB_LOCK_TIMEOUT_MS must be 0 (none) or milliseconds between ${TIMEOUT_MIN_MS} and ${TIMEOUT_MAX_MS} (default ${DB_LOCK_TIMEOUT_DEFAULT_MS}).`;
  }
  return null;
}

/** The pool settings from `env`; an invalid value reads as its default (`dbConfigError` refuses it at start). */
export function dbPoolSettings(env: NodeJS.ProcessEnv = process.env): DbPoolSettings {
  return {
    max: poolMax(env) ?? DB_POOL_MAX_DEFAULT,
    statementTimeoutMs: statementTimeout(env) ?? DB_STATEMENT_TIMEOUT_DEFAULT_MS,
    lockTimeoutMs: lockTimeout(env) ?? DB_LOCK_TIMEOUT_DEFAULT_MS,
  };
}

/** The postgres.js options of one of the two pools. */
export function dbClientOptions(settings: DbPoolSettings, pool: DbPool) {
  const connection: { statement_timeout?: number; lock_timeout?: number } = {};
  if (pool === 'request' && settings.statementTimeoutMs > 0) connection.statement_timeout = settings.statementTimeoutMs;
  if (settings.lockTimeoutMs > 0) connection.lock_timeout = settings.lockTimeoutMs;
  return {
    max: settings.max,
    connect_timeout: CONNECT_TIMEOUT_S,
    ...(pool === 'job' ? { idle_timeout: JOB_POOL_IDLE_TIMEOUT_S } : {}),
    connection,
  };
}

type Sql = ReturnType<typeof postgres>;

const CLIENTS = Symbol.for('drobek.db.clients');
const JOB_SCOPE = Symbol.for('drobek.db.jobScope');
type Holder = { [CLIENTS]?: Partial<Record<DbPool, Sql>>; [JOB_SCOPE]?: AsyncLocalStorage<true> };
const shared = globalThis as Holder;
const clients = (shared[CLIENTS] ??= {});
const jobScope = (shared[JOB_SCOPE] ??= new AsyncLocalStorage<true>());
const drizzles = new WeakMap<Sql, DB>();
let testDb: DB | null = null;

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required');
  }
  return url;
}

function client(kind: DbPool): Sql {
  return (clients[kind] ??= postgres(requireDatabaseUrl(), dbClientOptions(dbPoolSettings(), kind)));
}

function currentPool(): DbPool {
  return jobScope.getStore() ? 'job' : 'request';
}

/**
 * Run `fn` as background work: every query it makes — also from the timers
 * and promises it starts — goes to the background-job pool.
 */
export function runAsJob<T>(fn: () => T): T {
  return jobScope.run(true, fn);
}

/** Raw postgres.js client of the current pool (lazy singleton per pool). */
export function getSql(): Sql {
  return client(currentPool());
}

/** Drizzle client over the current pool (the request pool, or the job pool inside `runAsJob`). */
export function getDb(): DB {
  if (testDb) return testDb;
  const sql = getSql();
  let db = drizzles.get(sql);
  if (!db) {
    db = drizzle(sql, { schema });
    drizzles.set(sql, db);
  }
  return db;
}

/**
 * Swap in another drizzle database (tests: an in-process PGlite with the core
 * migrations applied). Pass null to go back to the DATABASE_URL pools.
 */
export function setDbForTests(db: unknown): void {
  testDb = db as DB | null;
}

/** Cheap connectivity probe used by @drobek/core runHealthChecks(). */
export async function healthDbPing(): Promise<void> {
  await getSql()`select 1`;
}

/** Close both pools (tests / tools). */
export async function closeDb(): Promise<void> {
  const open = Object.values(clients);
  for (const kind of Object.keys(clients) as DbPool[]) delete clients[kind];
  await Promise.all(open.map((sql) => sql.end({ timeout: 5 })));
}
