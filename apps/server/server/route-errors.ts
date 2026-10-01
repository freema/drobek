import { isRouteErrorResponse, type HandleErrorFunction, type ServerBuild } from 'react-router';
import { createConsoleLogger } from '@drobek/core';
import { dbErrorForLog } from '@drobek/db';

const httpLog = createConsoleLogger('http');

/**
 * React Router's default `handleError` does `console.error(error)` for an
 * error thrown by a loader or action — the whole object, which for a failed
 * query is a `DrizzleQueryError` carrying the SQL and its bound parameters
 * (e-mail addresses, token hashes) and a Postgres `detail`. This
 * one logs the same error through `dbErrorForLog` (code + constraint + table
 * and the stack frames for a DB error; message + stack otherwise). A build
 * whose entry defines its own `handleError` keeps it.
 *
 * The router's own 4xx answers (no route matches the URL → 404, a method
 * the route does not take such as OPTIONS → 405) are a client's guess, not
 * a server fault: one info line with the method, the path without its query
 * string and the status, no stack.
 */
export const logRouteError: HandleErrorFunction = (error, { request }) => {
  if (request.signal.aborted) return;
  if (isRouteErrorResponse(error) && error.status < 500) {
    httpLog.info('not served', { method: request.method, path: new URL(request.url).pathname, status: error.status });
    return;
  }
  const inner = isRouteErrorResponse(error) ? (error as { error?: unknown }).error : undefined;
  console.error(dbErrorForLog(inner ?? error, { stack: true }));
};

export function withSafeRouteErrors(build: ServerBuild): ServerBuild {
  if (build.entry.module.handleError) return build;
  return { ...build, entry: { ...build.entry, module: { ...build.entry.module, handleError: logRouteError } } };
}
