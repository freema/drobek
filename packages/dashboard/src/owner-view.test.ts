import { describe, expect, it } from 'vitest';
import { dayRange, editableJson, formatBytes, parseDay, parseRecordJson, safeFilename, sinceWindow, submissionFields } from './owner-view.js';

describe('owner-view helpers (M2-03)', () => {
  it('the record editor round-trips the own fields only', () => {
    const json = editableJson({ _id: 'r1', _owner: null, title: 'Milk', tags: ['a'] });
    expect(JSON.parse(json)).toEqual({ title: 'Milk', tags: ['a'] });
    expect(parseRecordJson(json)).toEqual({ ok: true, fields: { title: 'Milk', tags: ['a'] } });
    expect(parseRecordJson('[1]')).toMatchObject({ ok: false });
    expect(parseRecordJson('{nope')).toMatchObject({ ok: false, error: expect.stringContaining('Not valid JSON') });
  });

  it('day inputs → an inclusive UTC range as [from, to)', () => {
    expect(parseDay('2026-09-01')).toBe('2026-09-01');
    expect(parseDay('2026-9-1')).toBe('');
    expect(parseDay("2026-09-01' OR 1=1")).toBe('');
    expect(dayRange('2026-09-01', '2026-09-01')).toEqual({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' });
    expect(dayRange('', '')).toEqual({});
  });

  it('since windows default to 24 hours', () => {
    const now = new Date('2026-09-23T12:00:00Z');
    expect(sinceWindow('1h', now)).toEqual({ key: '1h', since: new Date('2026-09-23T11:00:00Z') });
    expect(sinceWindow('junk', now).key).toBe('24h');
    expect(sinceWindow(null, now).since.toISOString()).toBe('2026-09-22T12:00:00.000Z');
  });

  it('sizes, fields and file names', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MiB');
    expect(submissionFields({ b: ['x', 'y'], a: null, c: 3 })).toEqual([
      ['a', ''],
      ['b', 'x, y'],
      ['c', '3'],
    ]);
    expect(safeFilename('../ev"ilé.png', 'f')).toBe('.._ev_il_.png');
    expect(safeFilename('', 'file-1.png')).toBe('file-1.png');
  });
});
