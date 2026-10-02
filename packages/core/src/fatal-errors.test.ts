import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installErrorReporter, resetErrorReporterForTests, type ErrorReportEvent } from './error-report.js';
import { FATAL_STOP_MARGIN_MS, installFatalErrorHandlers, type FatalErrorProcess } from './fatal-errors.js';
import { noopLogger, type Logger } from './logger.js';

class FakeProcess extends EventEmitter implements FatalErrorProcess {
  exitCode: number | undefined;
  exits: number[] = [];
  exit(code: number): void {
    this.exits.push(code);
  }
}

function recordingLog(): Logger & { errors: { message: string; meta?: Record<string, unknown> }[] } {
  const errors: { message: string; meta?: Record<string, unknown> }[] = [];
  return { ...noopLogger, errors, error: (message, meta) => void errors.push({ message, meta }) };
}

function reporter(deliver: (e: ErrorReportEvent) => Promise<void> | void = () => {}): ErrorReportEvent[] {
  const events: ErrorReportEvent[] = [];
  installErrorReporter(
    {
      id: 'sink',
      label: 'Sink',
      report: async (e) => {
        events.push(e);
        await deliver(e);
      },
    },
    {},
    noopLogger
  );
  return events;
}

afterEach(() => {
  resetErrorReporterForTests();
  vi.useRealTimers();
});

describe('installFatalErrorHandlers', () => {
  it('an uncaught exception is logged, reported as fatal, stops the server gracefully and exits 1', async () => {
    const proc = new FakeProcess();
    const log = recordingLog();
    const events = reporter();
    const stop = vi.fn(async () => {});
    installFatalErrorHandlers({ log, stop, graceMs: 20_000, proc });

    proc.emit('uncaughtException', new Error('kaboom at user@example.com'));

    expect(proc.exitCode).toBe(1);
    expect(log.errors[0]?.message).toBe('uncaught exception — the server stops');
    expect(String(log.errors[0]?.meta?.error)).toContain('kaboom');
    await vi.waitFor(() => expect(proc.exits).toEqual([1]));
    expect(stop).toHaveBeenCalledWith('uncaughtException');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: 'fatal', message: 'uncaught exception', context: { kind: 'process' } });
    expect(events[0]?.error?.message).not.toContain('user@example.com');
  });

  it('an unhandled rejection does the same, with a database error read log-safe', async () => {
    const proc = new FakeProcess();
    const log = recordingLog();
    const events = reporter();
    const stop = vi.fn(async () => {});
    installFatalErrorHandlers({ log, stop, graceMs: 20_000, proc });

    const dbError = Object.assign(new Error('canceling statement due to statement timeout'), {
      name: 'PostgresError',
      severity: 'ERROR',
      code: '57014',
    });
    proc.emit('unhandledRejection', dbError);

    await vi.waitFor(() => expect(proc.exits).toEqual([1]));
    expect(stop).toHaveBeenCalledWith('unhandledRejection');
    expect(String(log.errors[0]?.meta?.error).split('\n')[0]).toBe('db error 57014');
    expect(events[0]).toMatchObject({ message: 'unhandled promise rejection', error: { name: 'DatabaseError', message: 'db error 57014' } });
  });

  it('exits only after the report went out, even when the stop finished first', async () => {
    const proc = new FakeProcess();
    let release!: () => void;
    reporter(() => new Promise<void>((resolve) => (release = resolve)));
    installFatalErrorHandlers({ log: noopLogger, stop: async () => {}, graceMs: 20_000, proc });

    proc.emit('uncaughtException', new Error('boom'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(proc.exits).toEqual([]);
    release();
    await vi.waitFor(() => expect(proc.exits).toEqual([1]));
  });

  it('a second error during the stop is logged and reported, but stops nothing twice', async () => {
    const proc = new FakeProcess();
    const log = recordingLog();
    const events = reporter();
    let finish!: () => void;
    const stop = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    installFatalErrorHandlers({ log, stop, graceMs: 20_000, proc });

    proc.emit('uncaughtException', new Error('first'));
    proc.emit('unhandledRejection', new Error('second'));
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(log.errors.map((e) => e.message)).toEqual(['uncaught exception — the server stops', 'unhandled promise rejection — the server stops']);
    finish();
    await vi.waitFor(() => expect(proc.exits).toEqual([1]));
  });

  it('a failing stop still exits 1, its error logged', async () => {
    const proc = new FakeProcess();
    const log = recordingLog();
    installFatalErrorHandlers({
      log,
      stop: () => {
        throw new Error('jobs would not stop');
      },
      graceMs: 20_000,
      proc,
    });

    proc.emit('uncaughtException', new Error('boom'));
    await vi.waitFor(() => expect(proc.exits).toEqual([1]));
    expect(log.errors.map((e) => e.message)).toContain('the server did not stop cleanly');
  });

  it('a stop that hangs is cut FATAL_STOP_MARGIN_MS after the grace period', async () => {
    vi.useFakeTimers();
    const proc = new FakeProcess();
    installFatalErrorHandlers({ log: noopLogger, stop: () => new Promise<void>(() => {}), graceMs: 1_000, proc });

    proc.emit('uncaughtException', new Error('boom'));
    await vi.advanceTimersByTimeAsync(1_000 + FATAL_STOP_MARGIN_MS - 1);
    expect(proc.exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(proc.exits).toEqual([1]);
  });

  it('the returned function removes both handlers', () => {
    const proc = new FakeProcess();
    const uninstall = installFatalErrorHandlers({ log: noopLogger, stop: async () => {}, graceMs: 1_000, proc });
    expect(proc.listenerCount('uncaughtException')).toBe(1);
    expect(proc.listenerCount('unhandledRejection')).toBe(1);
    uninstall();
    expect(proc.listenerCount('uncaughtException')).toBe(0);
    expect(proc.listenerCount('unhandledRejection')).toBe(0);
  });
});
