import { isRouteErrorResponse, type HandleErrorFunction, type ServerBuild } from 'react-router';
import { dbErrorForLog } from '@drobek/db';

/**
 * React Router's default `handleError` does `console.error(error)` for an
 * error thrown by a loader or action — the whole object, which for a failed
 * query is a `DrizzleQueryError` carrying the SQL and its bound parameters
 * (e-mail addresses, token hashes) and a Postgres `detail` (NSO-333). This
 * one logs the same error through `dbErrorForLog` (code + constraint + table
 * and the stack frames for a DB error; message + stack otherwise). A build
 * whose entry defines its own `handleError` keeps it.
 */
export const logRouteError: HandleErrorFunction = (error, { request }) => {
  if (request.signal.aborted) return;
  const inner = isRouteErrorResponse(error) ? (error as { error?: unknown }).error : undefined;
  console.error(dbErrorForLog(inner ?? error, { stack: true }));
};

export function withSafeRouteErrors(build: ServerBuild): ServerBuild {
  if (build.entry.module.handleError) return build;
  return { ...build, entry: { ...build.entry, module: { ...build.entry.module, handleError: logRouteError } } };
}
