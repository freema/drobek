import { describe, expect, it } from 'vitest';
import { DataError } from './errors.js';
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  normalizeSort,
  normalizeWhere,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from './query-build.js';

const fields = new Set(['title', 'done', 'priority']);

describe('normalizeWhere', () => {
  it('accepts whitelisted scalar equality filters', () => {
    expect(normalizeWhere({ done: true, priority: 3 }, fields)).toEqual([
      { field: 'done', value: true },
      { field: 'priority', value: 3 },
    ]);
  });

  it('accepts a null filter', () => {
    expect(normalizeWhere({ title: null }, fields)).toEqual([
      { field: 'title', value: null },
    ]);
  });

  it('rejects an unknown field (no probing arbitrary jsonb keys)', () => {
    expect(() => normalizeWhere({ secret: 1 }, fields)).toThrowError(DataError);
  });

  it('rejects a non-scalar value (no operator injection surface)', () => {
    expect(() => normalizeWhere({ done: { $gt: 1 } }, fields)).toThrowError(
      DataError
    );
  });

  it('treats undefined/empty as no filter', () => {
    expect(normalizeWhere(undefined, fields)).toEqual([]);
  });
});

describe('normalizeSort', () => {
  it('defaults to createdAt desc', () => {
    expect(normalizeSort(undefined, fields)).toEqual({
      field: 'createdAt',
      dir: 'desc',
      meta: true,
    });
  });

  it('accepts a metadata sort field', () => {
    expect(normalizeSort({ field: 'updatedAt', dir: 'asc' }, fields)).toEqual({
      field: 'updatedAt',
      dir: 'asc',
      meta: true,
    });
  });

  it('accepts a doc property sort field (defaults asc)', () => {
    expect(normalizeSort({ field: 'priority' }, fields)).toEqual({
      field: 'priority',
      dir: 'asc',
      meta: false,
    });
  });

  it('rejects an unknown sort field', () => {
    expect(() => normalizeSort({ field: 'ssn' }, fields)).toThrowError(DataError);
  });

  it('rejects a bad direction', () => {
    expect(() =>
      normalizeSort({ field: 'title', dir: 'sideways' }, fields)
    ).toThrowError(DataError);
  });
});

describe('clampLimit', () => {
  it('defaults, clamps to the max, and rejects junk', () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(10)).toBe(10);
    expect(clampLimit(9999)).toBe(MAX_LIMIT);
    expect(clampLimit(-5)).toBe(DEFAULT_LIMIT);
    expect(clampLimit('abc')).toBe(DEFAULT_LIMIT);
  });
});

describe('cursor encode/decode', () => {
  it('round-trips', () => {
    const c = encodeCursor({ v: 'alpha', i: 'id-1' });
    expect(decodeCursor(c)).toEqual({ v: 'alpha', i: 'id-1' });
  });

  it('round-trips a null value', () => {
    const c = encodeCursor({ v: null, i: 'id-2' });
    expect(decodeCursor(c)).toEqual({ v: null, i: 'id-2' });
  });

  it('treats empty as no cursor', () => {
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });

  it('rejects a malformed cursor', () => {
    expect(() => decodeCursor('!!!not-base64-json!!!')).toThrowError(DataError);
  });
});
