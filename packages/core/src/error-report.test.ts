/**
 * The installed error reporter: what an event carries (and never carries),
 * redaction of secrets and addresses, the timeout, the per-minute cap with
 * the duplicate filter, and that a failing reporter never reaches the caller.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  errorReporterConfigError,
  installErrorReporter,
  installedErrorReporterId,
  reportError,
  resetErrorReporterForTests,
  routeForReport,
  type ErrorReportEvent,
  type ErrorReporter,
} from './error-report.js';

const TOKEN = 'sink_test_fake_token_0123456789';
const MASTER = 'a'.repeat(64);

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function sink(over: Partial<ErrorReporter> = {}) {
  const events: ErrorReportEvent[] = [];
  const reporter: ErrorReporter = {
    id: 'sink',
    label: 'Sink',
    secrets: ['SINK_TOKEN'],
    report: (event) => {
      events.push(event);
    },
    ...over,
  };
  return { events, reporter };
}

const ENV = { SINK_TOKEN: TOKEN, DROBEK_MASTER_KEY: MASTER, DROBEK_VERSION: 'v1.4.0', NODE_ENV: 'production' };

afterEach(() => {
  resetErrorReporterForTests();
  vi.useRealTimers();
});

describe('reportError', () => {
  it('without a reporter it does nothing', async () => {
    await expect(reportError({ message: 'x', context: { kind: 'http' } })).resolves.toBeUndefined();
    expect(installedErrorReporterId()).toBeNull();
  });

  it('builds the event from an allow-list: release, environment, context, error name / message / stack', async () => {
    const { events, reporter } = sink();
    installErrorReporter(reporter, ENV, logger());
    const err = new TypeError('cannot read x');
    await reportError({
      message: 'module request failed',
      error: err,
      context: { kind: 'module_route', module: 'forms', route: '/__drobek/v1/forms/submit?email=a@b.example', method: 'post', status: 500, appId: 'app1', workspaceId: 'ws1' },
    });
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e).toMatchObject({
      level: 'error',
      message: 'module request failed',
      error: { name: 'TypeError', message: 'cannot read x' },
      context: { kind: 'module_route', module: 'forms', route: '/__drobek/v1/forms/submit', method: 'POST', status: 500, appId: 'app1', workspaceId: 'ws1' },
      release: 'v1.4.0',
      environment: 'production',
    });
    expect(e.error!.stack).toContain('TypeError: cannot read x');
    expect(Date.parse(e.timestamp)).not.toBeNaN();
    expect(e.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(Object.keys(e.context).sort()).toEqual(['appId', 'kind', 'method', 'module', 'route', 'status', 'workspaceId']);
  });

  it('redacts the reporter secrets, the server secrets, e-mail addresses and token-shaped text', async () => {
    const { events, reporter } = sink();
    installErrorReporter(reporter, ENV, logger());
    const err = new Error(`upstream said no for carol@corp.example with ${TOKEN}, key ${MASTER}, token=abc123 Bearer xyz.789`);
    await reportError({ message: 'send to dave@corp.example failed', error: err, context: { kind: 'email' } });
    const text = JSON.stringify(events);
    for (const secret of [TOKEN, MASTER, 'carol@corp.example', 'dave@corp.example', 'abc123', 'xyz.789']) expect(text).not.toContain(secret);
    expect(events[0]!.message).toBe('send to [email] failed');
    expect(events[0]!.error!.message).toContain('[redacted]');
  });

  it('redacts the previous master key of a rotation too, also when it is a passphrase', async () => {
    const { events, reporter } = sink();
    const previous = 'the old pass phrase, at least 32 chars';
    installErrorReporter(reporter, { ...ENV, DROBEK_MASTER_KEY_PREVIOUS: previous }, logger());
    await reportError({ message: 'rotation', error: new Error(`could not open with ${previous}`), context: { kind: 'startup' } });
    expect(JSON.stringify(events)).not.toContain(previous);
  });

  it('a database error keeps its code and table, never the SQL or the bound values', async () => {
    const { events, reporter } = sink();
    installErrorReporter(reporter, ENV, logger());
    const cause = Object.assign(new Error('duplicate key'), { name: 'PostgresError', severity: 'ERROR', code: '23505', table_name: 'users' });
    const err = Object.assign(new Error('Failed query: insert into "users" values ($1)\nparams: eve@corp.example', { cause }), {
      query: 'insert into "users" values ($1)',
      params: ['eve@corp.example'],
    });
    await reportError({ message: 'request failed', error: err, context: { kind: 'http' } });
    expect(events[0]!.error).toMatchObject({ name: 'DatabaseError', message: 'db error 23505 (table users)' });
    expect(JSON.stringify(events)).not.toMatch(/eve@|insert into/);
  });

  it('a reporter that throws is logged once per minute (secrets redacted) and never reaches the caller', async () => {
    const log = logger();
    const { reporter } = sink({
      report: () => {
        throw new Error(`refused ${TOKEN}`);
      },
    });
    installErrorReporter(reporter, ENV, log);
    await expect(reportError({ message: 'one', context: { kind: 'http' } })).resolves.toBeUndefined();
    await reportError({ message: 'two', context: { kind: 'http' } });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('the error reporter failed — the report is dropped', { reporter: 'sink', error: 'refused [redacted]' });
  });

  it('a delivery past ERROR_REPORTER_TIMEOUT_MS is aborted and logged', async () => {
    const log = logger();
    let aborted = false;
    const { reporter } = sink({
      report: (_e, { signal }) =>
        new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          })
        ),
    });
    installErrorReporter(reporter, { ...ENV, ERROR_REPORTER_TIMEOUT_MS: '100' }, log);
    const started = Date.now();
    await reportError({ message: 'slow', context: { kind: 'http' } });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(aborted).toBe(true);
    expect(log.warn).toHaveBeenCalledWith('the error reporter failed — the report is dropped', { reporter: 'sink', error: 'no answer within 100 ms (ERROR_REPORTER_TIMEOUT_MS)' });
  });

  it('caps the reports per minute (one log line) and sends an identical error once per minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T10:00:00Z'));
    const log = logger();
    const { events, reporter } = sink();
    installErrorReporter(reporter, { ...ENV, ERROR_REPORTER_MAX_PER_MINUTE: '3' }, log);
    for (let i = 0; i < 3; i++) await reportError({ message: 'same', error: new Error('boom 1'), context: { kind: 'http', route: '/a' } });
    expect(events).toHaveLength(1);
    await reportError({ message: 'same', error: new Error('boom 2'), context: { kind: 'http', route: '/a' } });
    expect(events).toHaveLength(1);
    for (const r of ['/b', '/c', '/d', '/e']) await reportError({ message: 'other', context: { kind: 'http', route: r } });
    expect(events.map((e) => e.context.route)).toEqual(['/a', '/b', '/c']);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toMatch(/over ERROR_REPORTER_MAX_PER_MINUTE/);

    vi.setSystemTime(new Date('2026-10-01T10:01:00Z'));
    await reportError({ message: 'same', error: new Error('boom 3'), context: { kind: 'http', route: '/a' } });
    expect(events).toHaveLength(4);
  });

  it('a report from inside a delivery is ignored (no loop)', async () => {
    const seen: string[] = [];
    const reporter: ErrorReporter = {
      id: 'sink',
      label: 'Sink',
      report: async (event) => {
        seen.push(event.message);
        await reportError({ message: 'nested', context: { kind: 'email' } });
      },
    };
    installErrorReporter(reporter, {}, logger());
    await reportError({ message: 'outer', context: { kind: 'http' } });
    expect(seen).toEqual(['outer']);
  });
});

describe('installErrorReporter', () => {
  it('refuses a missing secret and invalid limits; null uninstalls', () => {
    const { reporter } = sink();
    expect(() => installErrorReporter(reporter, {})).toThrow('the error reporter "sink" needs SINK_TOKEN in the server env');
    expect(() => installErrorReporter(reporter, { ...ENV, ERROR_REPORTER_TIMEOUT_MS: '5' })).toThrow(/ERROR_REPORTER_TIMEOUT_MS must be milliseconds/);
    installErrorReporter(reporter, ENV);
    expect(installedErrorReporterId()).toBe('sink');
    installErrorReporter(null);
    expect(installedErrorReporterId()).toBeNull();
  });

  it('errorReporterConfigError names the variable, never its value', () => {
    expect(errorReporterConfigError({})).toBeNull();
    expect(errorReporterConfigError({ ERROR_REPORTER: 'pager', ERROR_REPORTER_TIMEOUT_MS: '5000', ERROR_REPORTER_MAX_PER_MINUTE: '60' })).toBeNull();
    expect(errorReporterConfigError({ ERROR_REPORTER: 'Not-An-Id!' })).toMatch(/^ERROR_REPORTER must be empty/);
    expect(errorReporterConfigError({ ERROR_REPORTER_MAX_PER_MINUTE: '0' })).toMatch(/^ERROR_REPORTER_MAX_PER_MINUTE must be an integer/);
    expect(errorReporterConfigError({ ERROR_REPORTER_TIMEOUT_MS: 'soon' })).not.toContain('soon');
  });
});

describe('routeForReport', () => {
  it('drops the query string and masks token-like segments', () => {
    expect(routeForReport('/workspaces/acme/apps/shop?tab=logs#x')).toBe('/workspaces/acme/apps/shop');
    expect(routeForReport('/api/assets/upload/k3J9xLm2Qp8rT5vW7yZ1aB4c')).toBe('/api/assets/upload/:param');
    expect(routeForReport('/invite/a1b2c3d4e5f6')).toBe('/invite/:param');
  });
});
