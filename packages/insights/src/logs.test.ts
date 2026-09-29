import { describe, expect, it } from 'vitest';
import {
  COMPILE_ERRORS_KEEP,
  COMPILE_LOG_LIMIT,
  FAILING_PATHS_TOP,
  LOG_ENTRIES_MAX,
  capCompileErrors,
  compileEntries,
  daysBetween,
  requestEntries,
  runtimeEntries,
  statusClass,
  type CompileRow,
  type DailyRow,
} from './logs.js';
import { logsWindowStart } from './logs.server.js';
import { dedupErrors } from './shape.js';

describe('statusClass', () => {
  it('buckets statuses', () => {
    expect([200, 204, 301, 304, 400, 401, 404, 429, 500, 503].map(statusClass)).toEqual([
      '2xx', '2xx', '3xx', '3xx', '4xx', '4xx', '4xx', '4xx', '5xx', '5xx',
    ]);
    expect(statusClass(Number.NaN)).toBe('5xx');
  });
});

describe('capCompileErrors', () => {
  it('keeps the known fields, ≤ 20 entries, texts capped', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ code: 'build_error', file: 'src/a.tsx', line: i, column: 1, text: 'x'.repeat(900), extra: 'drop' }));
    const out = capCompileErrors(many);
    expect(out).toHaveLength(COMPILE_ERRORS_KEEP);
    expect(Object.keys(out[0]).sort()).toEqual(['code', 'column', 'file', 'line', 'text']);
    expect(out[0].text.length).toBeLessThanOrEqual(501);
    expect(capCompileErrors('nope')).toEqual([]);
    expect(capCompileErrors([null])).toEqual([{ code: 'build_error', file: null, line: null, column: null, text: '' }]);
  });
});

describe('compileEntries', () => {
  it('shapes ≤ 50 rows with ok/errors', () => {
    const rows: CompileRow[] = Array.from({ length: 60 }, (_, i) => ({
      versionNumber: 60 - i,
      ok: i % 2 === 0,
      errors: i % 2 === 0 ? [] : [{ code: 'build_error', file: 'src/main.tsx', line: 3, column: 4, text: 'Expected ";"' }],
      warningCount: 0,
      durationMs: 12,
      trigger: 'write_files',
      createdAt: new Date(Date.UTC(2026, 8, 23, 12, 0, 60 - i)),
    }));
    const out = compileEntries(rows);
    expect(out).toHaveLength(COMPILE_LOG_LIMIT);
    expect(out[0]).toEqual({ at: '2026-09-23T12:01:00.000Z', version: 60, ok: true, errors: [], warning_count: 0, duration_ms: 12, trigger: 'write_files' });
    expect(out[1].errors[0]).toEqual({ code: 'build_error', file: 'src/main.tsx', line: 3, column: 4, text: 'Expected ";"' });
  });
});

describe('runtimeEntries', () => {
  it('dedups, carries counts + the latest stack head, newest-seen first', () => {
    const at = (s: number) => new Date(Date.UTC(2026, 8, 23, 12, 0, s));
    const rows = [
      { dedupKey: 'b', type: 'error', message: 'B', stack: null, url: 'https://x/2', createdAt: at(30), ts: null },
      { dedupKey: 'a', type: 'error', message: 'A', stack: 'Error: A\n at f (main.js:1:2)\n' + 'x\n'.repeat(20), url: 'https://x/1', createdAt: at(20), ts: null },
      { dedupKey: 'a', type: 'error', message: 'A', stack: 'old', url: 'https://x/0', createdAt: at(10), ts: null },
    ];
    const stacks = new Map([['a', rows[1].stack], ['b', null]]);
    const out = runtimeEntries(dedupErrors(rows).errors, stacks);
    expect(out.map((e) => [e.message, e.count])).toEqual([['B', 1], ['A', 2]]);
    expect(out[1]).toMatchObject({ first_seen: at(10).toISOString(), last_seen: at(20).toISOString(), url: 'https://x/1', file_hint: 'main.js:1:2' });
    expect(out[1].stack!.split('\n')).toHaveLength(6);
  });
});

describe('requestEntries', () => {
  it('daily totals + per-module status classes, newest day first', () => {
    const out = requestEntries(
      [
        { day: '2026-09-22', requestCount: 10, count5xx: 1, path404Counts: { '/a': 2, '/b': 1 } },
        { day: '2026-09-23', requestCount: 4, count5xx: 0, path404Counts: null },
      ],
      [
        { day: '2026-09-23', module: 'data', statusClass: '2xx', count: 3 },
        { day: '2026-09-23', module: 'data', statusClass: '4xx', count: 2 },
        { day: '2026-09-23', module: 'forms', statusClass: '5xx', count: 1 },
        { day: '2026-09-21', module: 'data', statusClass: '4xx', count: 7 },
        { day: '2026-09-21', module: 'data', statusClass: 'weird', count: 99 },
      ]
    );
    expect(out.map((e) => e.day)).toEqual(['2026-09-23', '2026-09-22', '2026-09-21']);
    expect(out[0]).toEqual({
      day: '2026-09-23',
      requests: 4,
      count_5xx: 0,
      count_404: 0,
      modules: { data: { '2xx': 3, '3xx': 0, '4xx': 2, '5xx': 0 }, forms: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 1 } },
      failing_paths: { '4xx': [], '5xx': [] },
    });
    expect(out[1]).toMatchObject({ requests: 10, count_5xx: 1, count_404: 3, modules: {} });
    expect(out[2].modules.data['4xx']).toBe(7);
  });

  it('failing paths per day: file 404s + platform 4xx merged, 5xx apart, most frequent first; the counts are untouched', () => {
    const daily: DailyRow[] = [
      { day: '2026-09-22', requestCount: 10, count5xx: 2, path404Counts: { '/favicon.ico': 3, '/a': 1 } },
      { day: '2026-09-23', requestCount: 4, count5xx: 0, path404Counts: {} },
    ];
    const failing = new Map([
      ['2026-09-22', { '4xx': { '/__drobek/v1/data/x': '5', '/a': '1' }, '5xx': { '/__drobek/v1/proxy/y': '2' } }],
      ['2026-09-23', { '4xx': null, '5xx': null }],
    ]);
    const out = requestEntries(daily, [], failing);
    const plain = requestEntries(daily, []);
    expect(out.map(({ failing_paths: _f, ...rest }) => rest)).toEqual(plain.map(({ failing_paths: _f, ...rest }) => rest));
    expect(out[1]).toMatchObject({ day: '2026-09-22', count_404: 4, count_5xx: 2 });
    expect(out[1].failing_paths).toEqual({
      '4xx': [
        { path: '/__drobek/v1/data/x', count: 5 },
        { path: '/favicon.ico', count: 3 },
        { path: '/a', count: 2 },
      ],
      '5xx': [{ path: '/__drobek/v1/proxy/y', count: 2 }],
    });
    expect(out[0].failing_paths).toEqual({ '4xx': [], '5xx': [] });
    // Without the Redis half (flush off) the durable file 404s still list.
    expect(plain[1].failing_paths['4xx'].map((p) => p.path)).toEqual(['/favicon.ico', '/a']);
  });

  it('lists at most 10 failing paths per class; junk counts are skipped', () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`/p${String(i).padStart(2, '0')}`, i + 1]));
    const out = requestEntries(
      [{ day: '2026-09-22', requestCount: 1, count5xx: 0, path404Counts: many }],
      [],
      new Map([['2026-09-22', { '5xx': { '/ok': '1', '/nan': 'x', '/neg': '-2' } }]])
    );
    expect(out[0].failing_paths['4xx']).toHaveLength(FAILING_PATHS_TOP);
    expect(out[0].failing_paths['4xx'][0]).toEqual({ path: '/p29', count: 30 });
    expect(out[0].failing_paths['5xx']).toEqual([{ path: '/ok', count: 1 }]);
  });

  it('caps at 100 days', () => {
    const daily = daysBetween('2026-01-01', '2026-09-01').map((day) => ({ day, requestCount: 1, count5xx: 0, path404Counts: {} }));
    expect(requestEntries(daily, [])).toHaveLength(LOG_ENTRIES_MAX);
  });
});

describe('daysBetween / logsWindowStart', () => {
  it('lists inclusive UTC days', () => {
    expect(daysBetween('2026-09-21', '2026-09-23')).toEqual(['2026-09-21', '2026-09-22', '2026-09-23']);
    expect(daysBetween('2026-09-23', '2026-09-21')).toEqual([]);
    expect(daysBetween('nope', '2026-09-21')).toEqual([]);
  });

  it('clamps `since` into the 30-day window', () => {
    const now = new Date('2026-09-23T12:00:00Z');
    const floor = '2026-08-24T12:00:00.000Z';
    expect(logsWindowStart(undefined, now).toISOString()).toBe(floor);
    expect(logsWindowStart('garbage', now).toISOString()).toBe(floor);
    expect(logsWindowStart('2020-01-01T00:00:00Z', now).toISOString()).toBe(floor);
    expect(logsWindowStart('2026-09-23T11:00:00Z', now).toISOString()).toBe('2026-09-23T11:00:00.000Z');
  });
});
