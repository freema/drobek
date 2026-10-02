/**
 * An error nothing in the server caught — an `uncaughtException` or an
 * `unhandledRejection` — leaves the process in an unknown state, so the
 * server stops: the error is logged (log-safe, `dbErrorForLog`), handed to
 * the error reporter (`kind: 'process'`, `level: 'fatal'`) and the normal
 * graceful stop runs (in-flight requests drain for SHUTDOWN_GRACE_MS). The
 * process then exits with code 1, after the report was delivered or timed
 * out. A second error during the stop is logged and reported only. Should
 * the stop itself hang, the process exits FATAL_STOP_MARGIN_MS after the
 * grace period anyway.
 */
import { dbErrorForLog } from '@drobek/db';
import { reportError } from './error-report.js';
import type { Logger } from './logger.js';

/** How long past the shutdown grace a stop after a fatal error may run before the process exits regardless. */
export const FATAL_STOP_MARGIN_MS = 10_000;

type FatalEvent = 'uncaughtException' | 'unhandledRejection';

/** The part of `process` the handlers use (a fake in tests). */
export interface FatalErrorProcess {
  on(event: FatalEvent, listener: (err: unknown) => void): unknown;
  off(event: FatalEvent, listener: (err: unknown) => void): unknown;
  exit(code: number): void;
  exitCode?: number | string | null | undefined;
}

export interface FatalErrorHandlerOptions {
  log: Logger;
  /** The server's graceful stop (drain, close, stop the jobs) — without exiting; the handler exits once it settled. */
  stop: (reason: FatalEvent) => Promise<void>;
  /** SHUTDOWN_GRACE_MS: the stop gets this plus FATAL_STOP_MARGIN_MS. */
  graceMs: number;
  proc?: FatalErrorProcess;
}

const MESSAGES: Record<FatalEvent, string> = {
  uncaughtException: 'uncaught exception',
  unhandledRejection: 'unhandled promise rejection',
};

/** Install the handlers on `process`; returns a function that removes them. */
export function installFatalErrorHandlers(opts: FatalErrorHandlerOptions): () => void {
  const proc = opts.proc ?? process;
  let stopping = false;

  const handle = (event: FatalEvent) => (err: unknown) => {
    proc.exitCode = 1;
    const message = MESSAGES[event];
    opts.log.error(`${message} — the server stops`, { error: dbErrorForLog(err, { stack: true }) });
    const reported = reportError({ level: 'fatal', message, error: err, context: { kind: 'process' } });
    if (stopping) return;
    stopping = true;
    const backstop = setTimeout(() => proc.exit(1), opts.graceMs + FATAL_STOP_MARGIN_MS);
    backstop.unref?.();
    const stopped = Promise.resolve().then(() => opts.stop(event));
    void Promise.allSettled([reported, stopped]).then(([, outcome]) => {
      if (outcome.status === 'rejected') opts.log.error('the server did not stop cleanly', { error: dbErrorForLog(outcome.reason, { stack: true }) });
      clearTimeout(backstop);
      proc.exit(1);
    });
  };

  const onException = handle('uncaughtException');
  const onRejection = handle('unhandledRejection');
  proc.on('uncaughtException', onException);
  proc.on('unhandledRejection', onRejection);
  return () => {
    proc.off('uncaughtException', onException);
    proc.off('unhandledRejection', onRejection);
  };
}
