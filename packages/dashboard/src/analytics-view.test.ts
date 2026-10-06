import { describe, expect, it } from 'vitest';
import { analyticsDays, analyticsRanges, chartGeometry, formatShare, niceMax, shortDay, topKeyLabel } from './analytics-view.js';

describe('analytics ranges', () => {
  it('offers the ranges within the retention and picks 30 days by default', () => {
    expect(analyticsRanges([7, 30, 90], 90)).toEqual([7, 30, 90]);
    expect(analyticsRanges([7, 30, 90], 30)).toEqual([7, 30]);
    expect(analyticsRanges([7, 30, 90], 3)).toEqual([3]);
    expect(analyticsDays(null, [7, 30, 90])).toBe(30);
    expect(analyticsDays('90', [7, 30, 90])).toBe(90);
    expect(analyticsDays('91', [7, 30, 90])).toBe(30);
    expect(analyticsDays(null, [7])).toBe(7);
  });
});

describe('chartGeometry', () => {
  it('one axis for both counts: bars on the baseline, the line through the day centres', () => {
    const g = chartGeometry(
      [
        { day: '2026-10-04', views: 10, visitors: 4 },
        { day: '2026-10-05', views: 0, visitors: 0 },
        { day: '2026-10-06', views: 5, visitors: 5 },
      ],
      340,
      226
    );
    expect(g.max).toBe(10);
    expect(g.bars[0].y + g.bars[0].height).toBe(g.plot.bottom);
    expect(g.bars[0].y).toBe(g.plot.top);
    expect(g.bars[1].height).toBe(0);
    expect(g.line.split(' ')).toHaveLength(3);
    expect(g.ticks.map((t) => t.value)).toEqual([0, 5, 10]);
    expect(g.labels.map((l) => l.text)).toEqual(['4 Oct', '5 Oct', '6 Oct']);
  });

  it('an empty range still draws an axis', () => {
    const g = chartGeometry([{ day: '2026-10-06', views: 0, visitors: 0 }]);
    expect(g.max).toBe(1);
    expect(g.bars[0].height).toBe(0);
  });

  it('labels at most about six days on a long range', () => {
    const series = Array.from({ length: 90 }, (_, i) => ({ day: `2026-07-${String((i % 28) + 1).padStart(2, '0')}`, views: i, visitors: 0 }));
    expect(chartGeometry(series).labels.length).toBeLessThanOrEqual(7);
  });
});

describe('formatting', () => {
  it('rounds the axis, names the days and the other buckets', () => {
    expect([0, 1, 3, 7, 12, 99, 101, 4500].map(niceMax)).toEqual([1, 1, 5, 10, 20, 100, 200, 5000]);
    expect(shortDay('2026-10-06')).toBe('6 Oct');
    expect(topKeyLabel('__other__', 'path')).toBe('Other pages (past 200 a day)');
    expect(topKeyLabel('/about', 'path')).toBe('/about');
    expect(formatShare(0.214)).toBe('21 %');
    expect(formatShare(null)).toBe('—');
  });
});
