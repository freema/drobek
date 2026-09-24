import { createConsoleLogger, type Logger } from '@drobek/core';
import { dbErrorForLog } from '@drobek/db';

/** Shared structured logger for the auth package server code. */
export const logger: Logger = createConsoleLogger('drobek-auth');

/**
 * Flatten an unknown thrown value into log-safe metadata. A DB error keeps
 * only its code / constraint / table (`dbErrorForLog`) — never the failed
 * query's bound e-mail or token hash.
 */
export function serializeError(err: unknown): {
  message: string;
  stack?: string;
} {
  if (err instanceof Error) {
    return { message: dbErrorForLog(err), stack: dbErrorForLog(err, { stack: true }) };
  }
  return { message: dbErrorForLog(err) };
}
