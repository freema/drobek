import { describe, expect, it } from 'vitest';
import { DataError } from './errors.js';
import {
  DEFAULT_LIMIT,
  MAX_CONDITIONS,
  MAX_IN_VALUES,
  MAX_LIMIT,
  MAX_VALUE_CHARS,
  clampLimit,
  decodeCursor,
  encodeCursor,
  fieldAllowed,
  normalizeFilter,
  normalizeSort,
  parseFilterParam,
} from './query-build.js';

const fields = new Set(['title', 'done', 'priority']);

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DataError);
    return (err as DataError).code;
  }
  throw new Error('did not throw');
}

describe('normalizeFilter', () => {
  it('accepts whitelisted scalar equality filters', () => {
    expect(normalizeFilter({ done: true, priority: 3 }, fields)).toEqual([
      { field: 'done', op: 'eq', value: true },
      { field: 'priority', op: 'eq', value: 3 },
    ]);
  });

  it('accepts a null filter', () => {
    expect(normalizeFilter({ title: null }, fields)).toEqual([{ field: 'title', op: 'eq', value: null }]);
  });

  it('accepts the whitelisted operators', () => {
    expect(normalizeFilter({ priority: { gte: 2, lt: 5 }, title: { contains: 'mi' }, done: { in: [true, null] } }, fields)).toEqual([
      { field: 'priority', op: 'gte', value: 2 },
      { field: 'priority', op: 'lt', value: 5 },
      { field: 'title', op: 'contains', value: 'mi' },
      { field: 'done', op: 'in', value: [true, null] },
    ]);
  });

  it('rejects an unknown field (no probing arbitrary jsonb keys)', () => {
    expect(code(() => normalizeFilter({ secret: 1 }, fields))).toBe('invalid_request');
  });

  it('never allows the server fields, with or without a schema', () => {
    expect(code(() => normalizeFilter({ _owner: 'eu_1' }, null))).toBe('invalid_request');
    expect(code(() => normalizeFilter({ _id: 'x' }, fields))).toBe('invalid_request');
    expect(fieldAllowed('_created_at', null)).toBe(false);
  });

  it('without a schema, a field must look like an identifier', () => {
    expect(normalizeFilter({ anything: 1 }, null)).toEqual([{ field: 'anything', op: 'eq', value: 1 }]);
    for (const evil of ["title'); DROP TABLE apps; --", 'a b', 'a.b', '1abc', 'x'.repeat(65), "title->>'x'", '']) {
      expect(code(() => normalizeFilter({ [evil]: 1 }, null))).toBe('invalid_request');
    }
  });

  it('rejects unknown operators and Mongo-style operator injection', () => {
    expect(code(() => normalizeFilter({ done: { $gt: 1 } }, fields))).toBe('invalid_request');
    expect(code(() => normalizeFilter({ done: { regex: '.*' } }, fields))).toBe('invalid_request');
    expect(code(() => normalizeFilter({ done: {} }, fields))).toBe('invalid_request');
  });

  it('rejects non-scalar values, long strings and bad operand types', () => {
    expect(code(() => normalizeFilter({ done: [1] }, fields))).toBe('invalid_request');
    expect(code(() => normalizeFilter({ done: { eq: { nested: 1 } } }, fields))).toBe('invalid_request');
    expect(code(() => normalizeFilter({ priority: Number.NaN }, fields))).toBe('invalid_request');
    expect(code(() => normalizeFilter({ title: 'x'.repeat(MAX_VALUE_CHARS + 1) }, fields))).toBe('invalid_request');
    expect(code(() => normalizeFilter({ priority: { gt: true } }, fields))).toBe('invalid_request');
    expect(code(() => normalizeFilter({ title: { contains: null } }, fields))).toBe('invalid_request');
    expect(code(() => normalizeFilter({ done: { in: [] } }, fields))).toBe('invalid_request');
    expect(code(() => normalizeFilter({ done: { in: Array(MAX_IN_VALUES + 1).fill(1) } }, fields))).toBe('invalid_request');
    expect(code(() => normalizeFilter('done=true', fields))).toBe('invalid_request');
    expect(code(() => normalizeFilter([{ done: true }], fields))).toBe('invalid_request');
  });

  it('bounds the number of conditions', () => {
    const many = Object.fromEntries(Array.from({ length: MAX_CONDITIONS + 1 }, (_, i) => [`f${i}`, i]));
    expect(code(() => normalizeFilter(many, null))).toBe('invalid_request');
  });

  it('treats undefined/null as no filter', () => {
    expect(normalizeFilter(undefined, fields)).toEqual([]);
    expect(normalizeFilter(null, fields)).toEqual([]);
  });
});

describe('parseFilterParam', () => {
  it('parses JSON, treats blank as none, rejects garbage', () => {
    expect(parseFilterParam('{"done":false}')).toEqual({ done: false });
    expect(parseFilterParam('')).toBeUndefined();
    expect(parseFilterParam(undefined)).toBeUndefined();
    expect(code(() => parseFilterParam('{done'))).toBe('invalid_request');
  });
});

describe('normalizeSort', () => {
  it('defaults to _created_at desc', () => {
    expect(normalizeSort(undefined, fields)).toEqual({ field: '_created_at', dir: 'desc', meta: true });
  });

  it('accepts a server sort field', () => {
    expect(normalizeSort({ field: '_updated_at', dir: 'asc' }, fields)).toEqual({ field: '_updated_at', dir: 'asc', meta: true });
    expect(normalizeSort({ field: '_id' }, fields)).toEqual({ field: '_id', dir: 'asc', meta: true });
  });

  it('accepts a record property sort field (defaults asc)', () => {
    expect(normalizeSort({ field: 'priority' }, fields)).toEqual({ field: 'priority', dir: 'asc', meta: false });
  });

  it('rejects an unknown sort field, _owner and an injection attempt', () => {
    expect(code(() => normalizeSort({ field: 'ssn' }, fields))).toBe('invalid_request');
    expect(code(() => normalizeSort({ field: '_owner' }, null))).toBe('invalid_request');
    expect(code(() => normalizeSort({ field: 'id; DROP TABLE apps' }, null))).toBe('invalid_request');
  });

  it('rejects a bad direction', () => {
    expect(code(() => normalizeSort({ field: 'title', dir: 'sideways' }, fields))).toBe('invalid_request');
  });
});

describe('clampLimit', () => {
  it('defaults, clamps to the max, and rejects junk', () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(10)).toBe(10);
    expect(clampLimit('10')).toBe(10);
    expect(clampLimit(9999)).toBe(MAX_LIMIT);
    expect(clampLimit(-5)).toBe(DEFAULT_LIMIT);
    expect(clampLimit('abc')).toBe(DEFAULT_LIMIT);
    expect(clampLimit(500, 100)).toBe(100);
  });
});

describe('cursor encode/decode', () => {
  it('round-trips (the value is the text of a JSON value)', () => {
    const c = encodeCursor({ v: '"alpha"', i: 'id-1' });
    expect(decodeCursor(c)).toEqual({ v: '"alpha"', i: 'id-1' });
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
    expect(code(() => decodeCursor('!!!not-base64-json!!!'))).toBe('invalid_request');
    expect(code(() => decodeCursor(encodeCursor({ v: "1); DROP TABLE apps; --", i: 'x' })))).toBe('invalid_request');
    expect(code(() => decodeCursor(Buffer.from('{"v":1,"i":"x"}').toString('base64url')))).toBe('invalid_request');
    expect(code(() => decodeCursor('x'.repeat(3000)))).toBe('invalid_request');
  });
});
