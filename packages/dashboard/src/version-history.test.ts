import { describe, expect, it } from 'vitest';
import { countRanges, parseVersionNumber, rangeLabel, versionResultFrom, withVersionResult } from './version-history.js';

describe('parseVersionNumber', () => {
  it('accepts a positive integer that fits the column', () => {
    expect(parseVersionNumber('12')).toBe(12);
    expect(parseVersionNumber(' 7 ')).toBe(7);
    expect(parseVersionNumber('2147483647')).toBe(2147483647);
  });
  it('refuses everything else', () => {
    for (const raw of [null, undefined, '', '0', '-1', '1.5', '1e3', 'abc', '2147483648', '99999999999', 'NaN', 'Infinity']) {
      expect(parseVersionNumber(raw), String(raw)).toBeNull();
    }
  });
});

describe('ranges', () => {
  it('counts and labels ranges', () => {
    expect(countRanges(['3-41', '45'])).toBe(40);
    expect(countRanges([])).toBe(0);
    expect(rangeLabel(['3-41', '45'])).toBe('v3–v41, v45');
  });
});

describe('versionResultFrom', () => {
  const from = (q: string) => versionResultFrom(new URLSearchParams(q));
  it('reads a keep, an unkeep and a clean-up result', () => {
    expect(from('keptVersion=4')).toEqual({ kind: 'kept', number: 4 });
    expect(from('unkeptVersion=4&prunable=1')).toEqual({ kind: 'unkept', number: 4, prunable: true });
    expect(from('deletedCount=3&deletedRanges=1-2,5&deletedFailedOnly=1&stayed=2')).toEqual({
      kind: 'deleted',
      count: 3,
      ranges: ['1-2', '5'],
      failedOnly: true,
      stayed: 2,
    });
  });
  it('ignores malformed values', () => {
    expect(from('')).toBeNull();
    expect(from('keptVersion=x')).toBeNull();
    expect(from('deletedCount=3&deletedRanges=<b>&stayed=-1')).toEqual({ kind: 'deleted', count: 3, ranges: [], failedOnly: false, stayed: 0 });
  });
});

describe('withVersionResult', () => {
  it('keeps the page cursor, replaces an older result and closes the clean-up preview', () => {
    expect(withVersionResult('/workspaces/a/apps/b?before=20&keptVersion=3&cleanup=4&failedOnly=1', { unkeptVersion: '5' })).toBe(
      '/workspaces/a/apps/b?before=20&unkeptVersion=5'
    );
    expect(withVersionResult('/workspaces/a/apps/b', { deletedCount: '2' })).toBe('/workspaces/a/apps/b?deletedCount=2');
  });
});
