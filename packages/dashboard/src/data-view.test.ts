import { describe, expect, it } from 'vitest';
import { cellText, flattenRecord, mapFilterSort, rulesText, schemaSummary, type Column } from './data-view.js';

const columns: Column[] = [
  { key: 'title', required: true },
  { key: 'done', required: true },
  { key: 'priority', required: false },
];

describe('schemaSummary', () => {
  it('marks required keys with * and truncates with a +N more', () => {
    expect(schemaSummary(columns)).toBe('title*, done*, priority');
    const wide = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((key) => ({ key, required: false }));
    expect(schemaSummary(wide)).toBe('a, b, c, d, e, f +1 more');
  });
  it('a collection without a schema', () => {
    expect(schemaSummary([])).toBe('(no schema)');
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

describe('flattenRecord (record → column cells + extra fields)', () => {
  it('maps values to column order; other own fields are extra, the _… fields never', () => {
    const flat = flattenRecord({ _id: 'r1', _owner: null, title: 'ship', done: true, priority: 2, note: 'y' }, columns);
    expect(flat.cells).toEqual(['ship', 'true', '2']);
    expect(flat.hasExtra).toBe(true);
    expect(flat.extra).toEqual({ note: 'y' });
  });
  it('blanks missing columns', () => {
    const flat = flattenRecord({ _id: 'r1', title: 'only title' }, columns);
    expect(flat.cells).toEqual(['only title', '', '']);
    expect(flat.hasExtra).toBe(false);
  });
  it('treats a non-object as empty; ignores inherited keys', () => {
    expect(flattenRecord(null, columns).cells).toEqual(['', '', '']);
    expect(flattenRecord([1, 2], columns).cells).toEqual(['', '', '']);
    expect(flattenRecord(Object.create({ title: 'inherited' }), columns).cells).toEqual(['', '', '']);
  });
});

describe('mapFilterSort (table params → records query; unknown fields dropped)', () => {
  it('maps a column filter to an equality filter', () => {
    expect(mapFilterSort({ filterField: 'done', filterValue: 'true', columns })).toEqual({ filter: { done: 'true' } });
  });
  it('drops an unknown or blank filter field', () => {
    expect(mapFilterSort({ filterField: 'ssn', filterValue: '1', columns })).toEqual({});
    expect(mapFilterSort({ filterField: '', filterValue: 'x', columns })).toEqual({});
  });
  it('maps a column or server sort field + dir (default desc)', () => {
    expect(mapFilterSort({ sortField: 'title', dir: 'asc', columns })).toEqual({ sort: 'title', dir: 'asc' });
    expect(mapFilterSort({ sortField: 'priority', columns })).toEqual({ sort: 'priority', dir: 'desc' });
    expect(mapFilterSort({ sortField: '_created_at', dir: 'desc', columns })).toEqual({ sort: '_created_at', dir: 'desc' });
    expect(mapFilterSort({ sortField: '_updated_at', dir: 'asc', columns })).toEqual({ sort: '_updated_at', dir: 'asc' });
  });
  it('drops an unknown sort field (the default applies)', () => {
    expect(mapFilterSort({ sortField: 'evil', columns })).toEqual({});
    expect(mapFilterSort({ sortField: '_owner', columns })).toEqual({});
  });
  it('combines a filter and a sort', () => {
    expect(mapFilterSort({ filterField: 'done', filterValue: 'false', sortField: 'title', dir: 'asc', columns })).toEqual({
      filter: { done: 'false' },
      sort: 'title',
      dir: 'asc',
    });
  });
});

describe('rulesText', () => {
  it('lists the four operations in order', () => {
    expect(rulesText({ delete: 'admin', read: 'public', create: 'public', update: 'owner|admin' })).toBe(
      'read public · create public · update owner|admin · delete admin'
    );
  });
});
