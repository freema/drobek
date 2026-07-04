import { describe, expect, it } from 'vitest';
import {
  dedupErrors,
  shapeLogs,
  type ErrorRow,
  type DailyStatRow,
  type DeployRow,
} from './shape.js';

function errRow(over: Partial<ErrorRow>): ErrorRow {
  return {
    dedupKey: 'k1',
    type: 'error',
    message: 'boom',
    stack: 'Error: boom\n at app.js:1:1',
    url: 'https://x/app',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    ts: null,
    ...over,
  };
}

describe('dedupErrors', () => {
  it('groups by dedup key with counts + first/last seen', () => {
    const rows: ErrorRow[] = [
      errRow({ dedupKey: 'a', createdAt: new Date('2026-07-01T03:00:00Z'), url: '/late' }),
      errRow({ dedupKey: 'a', createdAt: new Date('2026-07-01T01:00:00Z'), url: '/early' }),
      errRow({ dedupKey: 'b', message: 'other', createdAt: new Date('2026-07-01T02:00:00Z') }),
    ];
    const view = dedupErrors(rows);
    expect(view.totalEvents).toBe(3);
    expect(view.distinctErrors).toBe(2);

    const a = view.errors.find((e) => e.dedupKey === 'a')!;
    expect(a.count).toBe(2);
    expect(a.firstSeen).toBe('2026-07-01T01:00:00.000Z');
    expect(a.lastSeen).toBe('2026-07-01T03:00:00.000Z');
    expect(a.lastUrl).toBe('/late'); // url of the most-recent occurrence
    expect(a.fileHint).toBe('app.js:1:1');
  });

  it('sorts by count desc', () => {
    const rows: ErrorRow[] = [
      errRow({ dedupKey: 'once' }),
      errRow({ dedupKey: 'twice' }),
      errRow({ dedupKey: 'twice', createdAt: new Date('2026-07-02T00:00:00Z') }),
    ];
    const view = dedupErrors(rows);
    expect(view.errors[0].dedupKey).toBe('twice');
    expect(view.errors[0].count).toBe(2);
  });

  it('is empty for no rows', () => {
    expect(dedupErrors([])).toEqual({
      totalEvents: 0,
      distinctErrors: 0,
      errors: [],
    });
  });
});

describe('shapeLogs', () => {
  it('sums requests/5xx and merges + sorts top-404 paths', () => {
    const daily: DailyStatRow[] = [
      { requestCount: 10, count5xx: 1, path404Counts: { '/missing': 2, '/gone': 5 } },
      { requestCount: 4, count5xx: 0, path404Counts: { '/missing': 3 } },
    ];
    const deploys: DeployRow[] = [
      {
        id: 'dpl_aaaaaaaa1111',
        state: 'ready',
        createdAt: new Date('2026-07-01T00:00:00Z'),
        activatedAt: new Date('2026-07-01T00:05:00Z'),
      },
    ];
    const view = shapeLogs({ daily, deploys, activeDeployId: 'dpl_aaaaaaaa1111' });
    expect(view.requests).toBe(14);
    expect(view.count5xx).toBe(1);
    // tie on count (5) → path ascending: '/gone' before '/missing'
    expect(view.top404Paths).toEqual([
      { path: '/gone', count: 5 },
      { path: '/missing', count: 5 },
    ]);
    expect(view.recentDeploys[0]).toMatchObject({
      shortId: 'dpl_aaaa',
      state: 'ready',
      active: true,
    });
  });

  it('handles empty signals', () => {
    const view = shapeLogs({ daily: [], deploys: [], activeDeployId: null });
    expect(view).toEqual({
      requests: 0,
      count5xx: 0,
      top404Paths: [],
      recentDeploys: [],
    });
  });
});
