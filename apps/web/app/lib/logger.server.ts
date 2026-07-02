import { createConsoleLogger, type Logger } from '@drobek/core';

/** Shared structured logger for the web app server code. */
export const logger: Logger = createConsoleLogger('drobek-web');

/** Flatten an unknown thrown value into log-safe metadata. */
export function serializeError(err: unknown): {
  message: string;
  stack?: string;
} {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}
