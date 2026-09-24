import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbErrorForLog, isUniqueViolation, pgErrorCode } from './errors.js';

const EMAIL = 'bob.secret@corp.example';

let pg: PGlite;
let db: ReturnType<typeof drizzle>;

/** The error a real failing query throws through drizzle (whatever version is installed). */
async function failing(query: ReturnType<typeof sql>): Promise<unknown> {
  try {
    await db.execute(query);
  } catch (err) {
    return err;
  }
  throw new Error('expected the query to fail');
}

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg);
  await pg.exec('create table people (id text primary key, email text not null constraint people_email_unique unique, n int)');
  await db.execute(sql`insert into people (id, email, n) values ('a', ${EMAIL}, 1)`);
});

afterAll(async () => {
  await pg.close();
});

describe('real driver errors (PGlite through drizzle)', () => {
  it('reads SQLSTATE 23505 of a unique violation', async () => {
    const err = await failing(sql`insert into people (id, email, n) values ('b', ${EMAIL}, 2)`);
    expect(pgErrorCode(err)).toBe('23505');
    expect(isUniqueViolation(err)).toBe(true);
  });

  it('a failed-query log line keeps code, constraint and table but never the bound e-mail', async () => {
    const err = await failing(sql`insert into people (id, email, n) values ('b', ${EMAIL}, 2)`);
    const line = JSON.stringify({ level: 'error', message: 'insert failed', error: dbErrorForLog(err, { stack: true }) });
    expect(line).toContain('db error 23505');
    expect(line).toContain('people_email_unique');
    expect(line).toContain('table people');
    expect(line).not.toContain(EMAIL);
    expect(line).not.toContain('params');
  });

  it('drops a Postgres message that quotes the input (22P02)', async () => {
    const err = await failing(sql`select * from people where n = ${EMAIL}`);
    expect(pgErrorCode(err)).toBe('22P02');
    expect(isUniqueViolation(err)).toBe(false);
    expect(dbErrorForLog(err)).toBe('db error 22P02');
    expect(dbErrorForLog(err, { stack: true })).not.toContain(EMAIL);
  });
});

describe('driver / drizzle shapes', () => {
  // drizzle-orm ≥ 0.44: the driver error is the cause, the message carries SQL + params.
  function drizzleWrapped(cause: unknown): Error {
    const e = new Error(`Failed query: insert into "people" ("email") values ($1)\nparams: ${EMAIL}`, { cause }) as Error & {
      query: string;
      params: unknown[];
    };
    e.name = 'DrizzleQueryError';
    e.query = 'insert into "people" ("email") values ($1)';
    e.params = [EMAIL];
    return e;
  }
  // postgres.js PostgresError.
  function postgresJs(code: string): Error {
    return Object.assign(new Error('duplicate key value violates unique constraint "apps_slug_unique"'), {
      name: 'PostgresError',
      severity: 'ERROR',
      code,
      detail: `Key (email)=(${EMAIL}) already exists.`,
      constraint_name: 'apps_slug_unique',
      table_name: 'apps',
    });
  }

  it('finds the code on a DrizzleQueryError cause (postgres.js)', () => {
    const err = drizzleWrapped(postgresJs('23505'));
    expect((err as { code?: unknown }).code).toBeUndefined();
    expect(pgErrorCode(err)).toBe('23505');
    expect(isUniqueViolation(err)).toBe(true);
    const text = dbErrorForLog(err, { stack: true });
    expect(text.split('\n')[0]).toBe('db error 23505 (constraint apps_slug_unique, table apps)');
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain('Failed query');
  });

  it('reads a bare postgres.js error (drizzle ≤ 0.43)', () => {
    expect(pgErrorCode(postgresJs('40001'))).toBe('40001');
    expect(dbErrorForLog(postgresJs('40001'))).toBe('db error 40001 (constraint apps_slug_unique, table apps)');
  });

  it('a connection failure under a DrizzleQueryError keeps the driver code only', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    const err = drizzleWrapped(cause);
    expect(pgErrorCode(err)).toBeUndefined();
    expect(isUniqueViolation(err)).toBe(false);
    expect(dbErrorForLog(err)).toBe('db error ECONNREFUSED');
    expect(dbErrorForLog(drizzleWrapped(undefined))).toBe('db error unknown');
  });

  it('a Node error code that looks like five letters is not a SQLSTATE', () => {
    expect(pgErrorCode(Object.assign(new Error('write EPIPE'), { code: 'EPIPE', severity: 'ERROR' }))).toBeUndefined();
    expect(pgErrorCode(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBeUndefined();
  });

  it('any other error keeps its message (or stack)', () => {
    const err = new Error('the address was not accepted');
    expect(dbErrorForLog(err)).toBe('the address was not accepted');
    expect(dbErrorForLog(err, { stack: true })).toBe(err.stack);
    expect(dbErrorForLog('boom')).toBe('boom');
    expect(dbErrorForLog(undefined)).toBe('undefined');
    expect(pgErrorCode(null)).toBeUndefined();
  });

  it('survives a cyclic cause chain', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(pgErrorCode(a)).toBeUndefined();
    expect(dbErrorForLog(a)).toBe('a');
  });
});
