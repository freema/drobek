import { describe, expect, it } from 'vitest';
import { cellText, csvHeader, csvRecordLine, schemaColumns } from './columns.js';

const TODO_SCHEMA = {
  type: 'object',
  required: ['title', 'done'],
  properties: { title: { type: 'string' }, done: { type: 'boolean' }, priority: { type: 'number' } },
  additionalProperties: false,
};

describe('schemaColumns (schema → ordered columns)', () => {
  it('lists required fields first (required-array order), then the rest', () => {
    expect(schemaColumns(TODO_SCHEMA)).toEqual([
      { key: 'title', required: true },
      { key: 'done', required: true },
      { key: 'priority', required: false },
    ]);
  });

  it('is deterministic and does not duplicate a required-also-listed key', () => {
    const schema = { required: ['a', 'a', 'zzz'], properties: { a: {}, b: {}, zzz: {} } };
    expect(schemaColumns(schema)).toEqual([
      { key: 'a', required: true },
      { key: 'zzz', required: true },
      { key: 'b', required: false },
    ]);
  });

  it('ignores a required entry without a property, and the server _… names', () => {
    expect(schemaColumns({ required: ['ghost', 'toString'], properties: { real: {}, _owner: {} } })).toEqual([{ key: 'real', required: false }]);
  });

  it('returns [] without properties or for a non-object', () => {
    expect(schemaColumns({})).toEqual([]);
    expect(schemaColumns({ properties: null })).toEqual([]);
    expect(schemaColumns(null)).toEqual([]);
    expect(schemaColumns(undefined)).toEqual([]);
    expect(schemaColumns('nope')).toEqual([]);
  });
});

describe('cellText (value → display string)', () => {
  it('renders scalars, blanks null/undefined, JSON-encodes objects', () => {
    expect(cellText('hi')).toBe('hi');
    expect(cellText(42)).toBe('42');
    expect(cellText(false)).toBe('false');
    expect(cellText(null)).toBe('');
    expect(cellText(undefined)).toBe('');
    expect(cellText({ a: 1 })).toBe('{"a":1}');
    expect(cellText([1, 2])).toBe('[1,2]');
  });
});

describe('CSV lines (RFC 4180 + formula neutralization)', () => {
  const record = { _id: 'r1', _owner: null, _created_at: '2026-09-23T10:00:00.000Z', _updated_at: '2026-09-23T10:00:00.000Z' };

  it('header = the server fields, then the keys', () => {
    expect(csvHeader(schemaColumns(TODO_SCHEMA).map((c) => c.key))).toBe('_id,_owner,_created_at,_updated_at,title,done,priority');
  });

  it('a line honors column order and escaping, and drops other keys', () => {
    const keys = ['title', 'done', 'priority'];
    expect(csvRecordLine({ ...record, title: 'a, b', done: false, priority: 3, extra: 'drop' }, keys)).toBe(
      'r1,,2026-09-23T10:00:00.000Z,2026-09-23T10:00:00.000Z,"a, b",false,3'
    );
    expect(csvRecordLine({ ...record, title: 'say "hi", ok', done: true }, keys)).toBe(
      'r1,,2026-09-23T10:00:00.000Z,2026-09-23T10:00:00.000Z,"say ""hi"", ok",true,'
    );
  });

  it('neutralizes spreadsheet formulas in every cell', () => {
    expect(csvRecordLine({ ...record, _owner: '=cmd', title: '=1+1', done: '@SUM(A1)', priority: '-1' }, ['title', 'done', 'priority'])).toBe(
      "r1,'=cmd,2026-09-23T10:00:00.000Z,2026-09-23T10:00:00.000Z,'=1+1,'@SUM(A1),'-1"
    );
    expect(csvHeader(['=HYPERLINK("http://evil","x")'])).toBe('_id,_owner,_created_at,_updated_at,"\'=HYPERLINK(""http://evil"",""x"")"');
  });
});
