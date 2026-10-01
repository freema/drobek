/**
 * The dashboard keywords of a config field (ConfigFieldMeta, set with zod's
 * `.meta()`): `x-drobek-choices` / `x-drobek-min-interval` reach the form
 * fields through the real `z.toJSONSchema` (input side, like
 * ModuleRuntime.configJsonSchema), a record's `propertyNames` title labels
 * its entries' names, and a select's value round-trips like any string.
 */
import { describe, expect, it } from 'vitest';
import { z, type ConfigFieldMeta } from '@drobek/modules';
import { choiceKey, choiceRequests, entryInputs, fieldName, formToConfig, schemaFields, type FormField, type FormReader } from './module-config.js';

const SOURCE = z.strictObject({
  upstream: z.string().meta({ title: 'Upstream', 'x-drobek-choices': 'upstreams' } satisfies ConfigFieldMeta),
  every: z
    .string()
    .default('1h')
    .meta({ title: 'Schedule', 'x-drobek-choices': 'intervals', 'x-drobek-min-interval': 'IMPORT_MIN_INTERVAL_MIN' } satisfies ConfigFieldMeta),
  collection: z.string().meta({ 'x-drobek-choices': 'collections' } satisfies ConfigFieldMeta),
  note: z.string().optional(),
});

const SCHEMA = z.strictObject({
  sources: z.record(z.string().meta({ title: 'Source name', description: 'Lowercase, a letter first.' }), SOURCE).default({}),
  fallback: z.string().optional().meta({ 'x-drobek-choices': 'upstreams' } satisfies ConfigFieldMeta),
  backup: z.strictObject({ every: z.string().optional().meta({ 'x-drobek-choices': 'intervals' } satisfies ConfigFieldMeta) }).optional(),
  tags: z.record(z.string(), z.strictObject({ color: z.string() })).default({}),
});

const fields = () => schemaFields(z.toJSONSchema(SCHEMA, { unrepresentable: 'any', io: 'input' }));

function byPath(list: readonly FormField[], path: string): FormField {
  const f = list.find((x) => x.path === path);
  if (!f) throw new Error(`no field ${path}`);
  return f;
}

function reader(entries: Record<string, string>): FormReader {
  const m = new Map(Object.entries(entries));
  return { get: (k) => m.get(k) ?? null, has: (k) => m.has(k) };
}

describe('x-drobek-choices', () => {
  it('a string field carries where its choices come from (+ the limit of an interval field); it stays a string field', () => {
    const sources = byPath(fields(), 'sources');
    const entry = sources.entry ?? [];
    expect(byPath(entry, 'upstream')).toMatchObject({ kind: 'string', required: true, choices: 'upstreams' });
    expect(byPath(entry, 'every')).toMatchObject({ kind: 'string', required: false, default: '1h', choices: 'intervals', minInterval: 'IMPORT_MIN_INTERVAL_MIN' });
    expect(byPath(entry, 'collection')).toMatchObject({ kind: 'string', choices: 'collections' });
    expect(byPath(entry, 'note').choices).toBeUndefined();
    expect(byPath(fields(), 'fallback')).toMatchObject({ kind: 'string', required: false, choices: 'upstreams' });
    expect(byPath(byPath(fields(), 'backup').children ?? [], 'backup.every')).toMatchObject({ choices: 'intervals' });
    expect(byPath(byPath(fields(), 'backup').children ?? [], 'backup.every').minInterval).toBeUndefined();
  });

  it('an unknown source, a non-string field or an enum ignore the keyword; the minimum only goes with intervals', () => {
    const odd = z.strictObject({
      typo: z.string().meta({ 'x-drobek-choices': 'upstream' }),
      count: z.int().meta({ 'x-drobek-choices': 'upstreams' }),
      mode: z.enum(['a', 'b']).meta({ 'x-drobek-choices': 'collections' }),
      stray: z.string().meta({ 'x-drobek-choices': 'collections', 'x-drobek-min-interval': 'X_MIN' }),
    });
    const list = schemaFields(z.toJSONSchema(odd, { unrepresentable: 'any', io: 'input' }));
    expect(byPath(list, 'typo').choices).toBeUndefined();
    expect(byPath(list, 'count')).toMatchObject({ kind: 'integer' });
    expect(byPath(list, 'count').choices).toBeUndefined();
    expect(byPath(list, 'mode')).toMatchObject({ kind: 'enum', options: ['a', 'b'] });
    expect(byPath(list, 'mode').choices).toBeUndefined();
    expect(byPath(list, 'stray')).toEqual(expect.objectContaining({ choices: 'collections' }));
    expect(byPath(list, 'stray').minInterval).toBeUndefined();
  });

  it('choiceRequests: every list the form needs once — entries and nested objects included; intervals per minimum', () => {
    expect(choiceRequests(fields())).toEqual([
      { key: 'upstreams', from: 'upstreams' },
      { key: 'intervals:IMPORT_MIN_INTERVAL_MIN', from: 'intervals', minInterval: 'IMPORT_MIN_INTERVAL_MIN' },
      { key: 'collections', from: 'collections' },
      { key: 'intervals:', from: 'intervals' },
    ]);
    expect(choiceKey({})).toBeNull();
    expect(choiceRequests(schemaFields(z.toJSONSchema(z.strictObject({ a: z.string() }), { io: 'input' })))).toEqual([]);
  });

  it('a chosen value is posted and read like any string (the schema on the server validates it)', () => {
    const list = fields();
    const sources = entryInputs.prefix('sources', 0);
    const parsed = formToConfig(
      list,
      reader({
        [entryInputs.count('sources')]: '1',
        [entryInputs.key('sources', 0)]: 'players',
        [fieldName(`${sources}.upstream`)]: 'scores',
        [fieldName(`${sources}.every`)]: '15m',
        [fieldName(`${sources}.collection`)]: 'players',
        [entryInputs.count('tags')]: '0',
        [fieldName('fallback')]: '',
      })
    );
    expect(parsed.errors).toEqual({});
    expect(parsed.value).toMatchObject({ sources: { players: { upstream: 'scores', every: '15m', collection: 'players' } } });
    expect(parsed.value).not.toHaveProperty('fallback');
  });
});

describe("a record's entry names", () => {
  it("are labelled by the record's propertyNames title / description; without either there is no entryKey (the form says Name)", () => {
    expect(byPath(fields(), 'sources').entryKey).toEqual({ label: 'Source name', description: 'Lowercase, a letter first.' });
    expect(byPath(fields(), 'tags').entryKey).toBeUndefined();
    const hinted = z.strictObject({ m: z.record(z.string().describe('The key'), z.number()) });
    expect(byPath(schemaFields(z.toJSONSchema(hinted, { io: 'input' })), 'm').entryKey).toEqual({ label: 'Name', description: 'The key' });
  });
});
