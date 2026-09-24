import type { ServerBuild } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logRouteError, withSafeRouteErrors } from './route-errors.js';

const EMAIL = 'carol.hidden@corp.example';

/** The drizzle-orm ≥ 0.44 shape of a failed query (postgres.js cause). */
function failedQuery(): Error {
  const cause = Object.assign(new Error('duplicate key value violates unique constraint "users_email_unique"'), {
    name: 'PostgresError',
    severity: 'ERROR',
    code: '23505',
    detail: `Key (email)=(${EMAIL}) already exists.`,
    constraint_name: 'users_email_unique',
    table_name: 'users',
  });
  return Object.assign(new Error(`Failed query: insert into "users" ("email") values ($1)\nparams: ${EMAIL}`, { cause }), {
    query: 'insert into "users" ("email") values ($1)',
    params: [EMAIL],
  });
}

const args = (aborted = false) => {
  const ctrl = new AbortController();
  if (aborted) ctrl.abort();
  return { request: new Request('http://drobek.test/workspaces', { signal: ctrl.signal }), params: {}, context: undefined as never };
};

afterEach(() => vi.restoreAllMocks());

describe('route error logging (NSO-333)', () => {
  it('a failed query in a loader is logged without its bound values', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logRouteError(failedQuery(), args());
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = String(spy.mock.calls[0][0]);
    expect(logged.split('\n')[0]).toBe('db error 23505 (constraint users_email_unique, table users)');
    expect(logged).not.toContain(EMAIL);
  });

  it('an aborted request logs nothing', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logRouteError(new Error('x'), args(true));
    expect(spy).not.toHaveBeenCalled();
  });

  it('installs the handler only where the build has none', () => {
    const build = { entry: { module: { default: () => new Response() } } } as unknown as ServerBuild;
    expect(withSafeRouteErrors(build).entry.module.handleError).toBe(logRouteError);
    const own = () => {};
    const custom = { entry: { module: { default: () => new Response(), handleError: own } } } as unknown as ServerBuild;
    expect(withSafeRouteErrors(custom).entry.module.handleError).toBe(own);
  });
});
