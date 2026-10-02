import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DB_LOCK_TIMEOUT_DEFAULT_MS,
  DB_POOL_MAX_DEFAULT,
  DB_STATEMENT_TIMEOUT_DEFAULT_MS,
  closeDb,
  dbClientOptions,
  dbConfigError,
  dbPoolSettings,
  getDb,
  getSql,
  runAsJob,
  setDbForTests,
} from './client.js';

describe('pool settings', () => {
  it('has production defaults', () => {
    expect(dbPoolSettings({})).toEqual({
      max: DB_POOL_MAX_DEFAULT,
      statementTimeoutMs: DB_STATEMENT_TIMEOUT_DEFAULT_MS,
      lockTimeoutMs: DB_LOCK_TIMEOUT_DEFAULT_MS,
    });
    expect(dbPoolSettings({})).toEqual({ max: 20, statementTimeoutMs: 30_000, lockTimeoutMs: 10_000 });
    expect(dbConfigError({})).toBeNull();
  });

  it('reads DB_POOL_MAX, DB_STATEMENT_TIMEOUT_MS and DB_LOCK_TIMEOUT_MS; 0 turns a timeout off', () => {
    const env = { DB_POOL_MAX: ' 25 ', DB_STATEMENT_TIMEOUT_MS: '0', DB_LOCK_TIMEOUT_MS: '2500' };
    expect(dbConfigError(env)).toBeNull();
    expect(dbPoolSettings(env)).toEqual({ max: 25, statementTimeoutMs: 0, lockTimeoutMs: 2500 });
  });

  it('refuses a value out of range at start and reads it as the default meanwhile', () => {
    expect(dbConfigError({ DB_POOL_MAX: '0' })).toMatch(/^DB_POOL_MAX must be/);
    expect(dbConfigError({ DB_POOL_MAX: '1.5' })).toMatch(/^DB_POOL_MAX must be/);
    expect(dbConfigError({ DB_STATEMENT_TIMEOUT_MS: '30' })).toMatch(/^DB_STATEMENT_TIMEOUT_MS must be/);
    expect(dbConfigError({ DB_STATEMENT_TIMEOUT_MS: '30s' })).toMatch(/^DB_STATEMENT_TIMEOUT_MS must be/);
    expect(dbConfigError({ DB_LOCK_TIMEOUT_MS: '-1' })).toMatch(/^DB_LOCK_TIMEOUT_MS must be/);
    expect(dbPoolSettings({ DB_POOL_MAX: 'many', DB_LOCK_TIMEOUT_MS: '5' })).toEqual(dbPoolSettings({}));
  });

  it('the request pool carries both timeouts, the job pool the lock timeout only', () => {
    const settings = { max: 7, statementTimeoutMs: 30_000, lockTimeoutMs: 10_000 };
    expect(dbClientOptions(settings, 'request')).toEqual({
      max: 7,
      connect_timeout: 5,
      connection: { statement_timeout: 30_000, lock_timeout: 10_000 },
    });
    expect(dbClientOptions(settings, 'job')).toEqual({ max: 7, connect_timeout: 5, idle_timeout: 60, connection: { lock_timeout: 10_000 } });
    expect(dbClientOptions({ ...settings, statementTimeoutMs: 0, lockTimeoutMs: 0 }, 'request').connection).toEqual({});
  });
});

describe('the two pools', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://drobek:x@127.0.0.1:1/never';
    delete process.env.DB_POOL_MAX;
    delete process.env.DB_STATEMENT_TIMEOUT_MS;
    delete process.env.DB_LOCK_TIMEOUT_MS;
  });

  afterEach(async () => {
    setDbForTests(null);
    await closeDb();
    process.env = { ...saved };
  });

  it('a request uses the request pool; runAsJob and the timers it starts use the job pool', async () => {
    process.env.DB_STATEMENT_TIMEOUT_MS = '15000';
    const request = getSql();
    const job = runAsJob(() => getSql());
    expect(job).not.toBe(request);
    expect(getSql()).toBe(request);
    expect(request.options.connection).toMatchObject({ statement_timeout: 15_000, lock_timeout: 10_000 });
    expect(job.options.connection).toMatchObject({ lock_timeout: 10_000 });
    expect(job.options.connection).not.toHaveProperty('statement_timeout');
    expect(request.options.max).toBe(20);

    const fromTimer = await runAsJob(() => new Promise((resolve) => setTimeout(() => resolve(getSql()), 1)));
    expect(fromTimer).toBe(job);
    expect(runAsJob(() => getDb())).not.toBe(getDb());
  });

  it('a test database wins in both scopes', () => {
    const fake = { fake: true };
    setDbForTests(fake);
    expect(getDb()).toBe(fake);
    expect(runAsJob(() => getDb())).toBe(fake);
  });

  it('closeDb ends both pools; the next query opens new ones', async () => {
    const request = getSql();
    const job = runAsJob(() => getSql());
    await closeDb();
    expect(getSql()).not.toBe(request);
    expect(runAsJob(() => getSql())).not.toBe(job);
  });
});
