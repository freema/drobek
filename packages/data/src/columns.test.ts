import { describe, expect, it } from 'vitest';
import {
  cellText,
  csvEscape,
  csvHeader,
  csvRow,
  flattenDoc,
  mapFilterSort,
  schemaColumns,
  schemaSummary,
} from './columns.js';

const TODO_SCHEMA = {
  type: 'object',
  required: ['title', 'done'],
  properties: {
    title: { type: 'string' },
    done: { type: 'boolean' },
    priority: { type: 'number' },
  },
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
    const schema = {
      required: ['a', 'a', 'zzz'],
      properties: { a: {}, b: {}, zzz: {} },
    };
    expect(schemaColumns(schema)).toEqual([
      { key: 'a', required: true },
      { key: 'zzz', required: true },
      { key: 'b', required: false },
    ]);
  });

  it('ignores a required entry that has no matching property', () => {
    const schema = { required: ['ghost'], properties: { real: {} } };
    expect(schemaColumns(schema)).toEqual([{ key: 'real', required: false }]);
  });

  it('returns [] for a schema with no properties or a non-object', () => {
    expect(schemaColumns({})).toEqual([]);
    expect(schemaColumns({ properties: null })).toEqual([]);
    expect(schemaColumns(null)).toEqual([]);
    expect(schemaColumns('nope')).toEqual([]);
  });
});

describe('schemaSummary', () => {
  it('marks required keys with * and truncates with a +N more', () => {
    expect(schemaSummary(TODO_SCHEMA)).toBe('title*, done*, priority');
    const wide = {
      required: [],
      properties: { a: {}, b: {}, c: {}, d: {}, e: {}, f: {}, g: {} },
    };
    expect(schemaSummary(wide)).toBe('a, b, c, d, e, f +1 more');
  });
  it('handles an empty schema', () => {
    expect(schemaSummary({})).toBe('(no fields)');
  });
});

describe('cellText (scalar → display string)', () => {
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

describe('flattenDoc (record → column cells + extra keys)', () => {
  const cols = schemaColumns(TODO_SCHEMA);
  it('maps values to column order and collects non-schema keys as extra', () => {
    const flat = flattenDoc(
      { title: 'ship', done: true, priority: 2, secret: 'x', note: 'y' },
      cols
    );
    expect(flat.cells).toEqual(['ship', 'true', '2']);
    expect(flat.hasExtra).toBe(true);
    expect(flat.extra).toEqual({ secret: 'x', note: 'y' });
  });
  it('blanks missing columns and reports no extra when the doc is schema-clean', () => {
    const flat = flattenDoc({ title: 'only title' }, cols);
    expect(flat.cells).toEqual(['only title', '', '']);
    expect(flat.hasExtra).toBe(false);
    expect(flat.extra).toEqual({});
  });
  it('treats a non-object doc as empty', () => {
    expect(flattenDoc(null, cols).cells).toEqual(['', '', '']);
    expect(flattenDoc([1, 2], cols).cells).toEqual(['', '', '']);
  });
});

describe('CSV serialization (RFC-4180 escaping + column ordering)', () => {
  it('quotes fields containing quotes, commas or newlines and doubles quotes', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape('carriage\rreturn')).toBe('"carriage\rreturn"');
  });

  it('neutralizes spreadsheet formula injection with a leading quote (PHY-76 #4)', () => {
    // Leading =/+/-/@ triggers a formula in Excel/LibreOffice/Sheets.
    expect(csvEscape('=1+1')).toBe("'=1+1");
    expect(csvEscape('+1')).toBe("'+1");
    expect(csvEscape('-1')).toBe("'-1");
    expect(csvEscape('@SUM(A1)')).toBe("'@SUM(A1)");
    // Leading tab is guarded ('); tab is not in the RFC quote-set so no wrap.
    expect(csvEscape('\t=1')).toBe("'\t=1");
    // Leading CR is guarded AND RFC-quoted (\r is in the quote-set).
    expect(csvEscape('\r=1')).toBe('"\'\r=1"');
    // A classic exfil / RCE payload is defanged AND RFC-quoted for its comma.
    expect(csvEscape('=HYPERLINK("http://evil","x")')).toBe(
      '"\'=HYPERLINK(""http://evil"",""x"")"'
    );
    // Non-leading triggers are untouched (only the FIRST char matters).
    expect(csvEscape('a=1')).toBe('a=1');
    expect(csvEscape('3-2')).toBe('3-2');
  });

  it('header = schema field names in column order', () => {
    expect(csvHeader(schemaColumns(TODO_SCHEMA))).toBe('title,done,priority');
  });

  it('row honors column order, escaping, and ignores extra keys', () => {
    const cols = schemaColumns(TODO_SCHEMA);
    expect(
      csvRow({ title: 'a, b', done: false, priority: 3, extra: 'drop' }, cols)
    ).toBe('"a, b",false,3');
    // A quote-and-comma value + a missing optional column.
    expect(csvRow({ title: 'say "hi", ok', done: true }, cols)).toBe(
      '"say ""hi"", ok",true,'
    );
  });
});

describe('mapFilterSort (dashboard params → query API; unknown fields dropped)', () => {
  const columns = schemaColumns(TODO_SCHEMA);

  it('maps a known filter field + value to a where clause', () => {
    expect(
      mapFilterSort({ filterField: 'done', filterValue: 'true', columns })
    ).toEqual({ where: { done: 'true' } });
  });

  it('DROPS an unknown filter field (silently ignored, not a where)', () => {
    expect(
      mapFilterSort({ filterField: 'ssn', filterValue: '1', columns })
    ).toEqual({});
    expect(mapFilterSort({ filterField: '', filterValue: 'x', columns })).toEqual(
      {}
    );
  });

  it('maps a schema sort field + dir (default desc)', () => {
    expect(mapFilterSort({ sortField: 'title', dir: 'asc', columns })).toEqual({
      sort: { field: 'title', dir: 'asc' },
    });
    expect(mapFilterSort({ sortField: 'priority', columns })).toEqual({
      sort: { field: 'priority', dir: 'desc' },
    });
  });

  it('allows the createdAt/updatedAt/id metadata columns for sort', () => {
    expect(mapFilterSort({ sortField: 'createdAt', dir: 'desc', columns })).toEqual(
      { sort: { field: 'createdAt', dir: 'desc' } }
    );
  });

  it('DROPS an unknown sort field (falls back to the default)', () => {
    expect(mapFilterSort({ sortField: 'evil', columns })).toEqual({});
  });

  it('combines a filter and a sort', () => {
    expect(
      mapFilterSort({
        filterField: 'done',
        filterValue: 'false',
        sortField: 'title',
        dir: 'asc',
        columns,
      })
    ).toEqual({ where: { done: 'false' }, sort: { field: 'title', dir: 'asc' } });
  });
});
