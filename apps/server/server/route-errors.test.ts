import { UNSAFE_ErrorResponseImpl as ErrorResponseImpl, type ServerBuild } from 'react-router';
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

const args = (aborted = false, url = 'http://drobek.test/workspaces', method = 'GET') => {
  const ctrl = new AbortController();
  if (aborted) ctrl.abort();
  return { request: new Request(url, { method, signal: ctrl.signal }), params: {}, context: undefined as never };
};

function routerError(status: number, statusText: string, message: string): unknown {
  return new ErrorResponseImpl(status, statusText, new Error(message), true);
}

afterEach(() => vi.restoreAllMocks());

describe('route error logging', () => {
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

  it('a URL no route matches logs one info line without the query string or a stack', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const url = 'http://drobek.test/wp-admin/install.php?step=1&token=secret';
    logRouteError(routerError(404, 'Not Found', 'No route matches URL "/wp-admin/install.php"'), args(false, url));
    expect(error).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(info.mock.calls[0][0])) as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'info', method: 'GET', path: '/wp-admin/install.php', status: 404 });
    expect(String(info.mock.calls[0][0])).not.toMatch(/secret|step=|No route matches|at /);
  });

  it('a method the route does not take (OPTIONS → 405) logs one info line', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    logRouteError(routerError(405, 'Method Not Allowed', 'Invalid request method "OPTIONS"'), args(false, 'http://drobek.test/login', 'OPTIONS'));
    expect(error).not.toHaveBeenCalled();
    expect(JSON.parse(String(info.mock.calls[0][0]))).toMatchObject({ method: 'OPTIONS', path: '/login', status: 405 });
  });

  it('a 5xx route error response still logs as an error with its stack', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    logRouteError(routerError(500, 'Internal Server Error', 'boom'), args());
    expect(info).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('boom');
    expect(String(error.mock.calls[0][0])).toMatch(/\n\s+at /);
  });

  it('installs the handler only where the build has none', () => {
    const build = { entry: { module: { default: () => new Response() } } } as unknown as ServerBuild;
    expect(withSafeRouteErrors(build).entry.module.handleError).toBe(logRouteError);
    const own = () => {};
    const custom = { entry: { module: { default: () => new Response(), handleError: own } } } as unknown as ServerBuild;
    expect(withSafeRouteErrors(custom).entry.module.handleError).toBe(own);
  });
});
