/**
 * The generic config form for a THIRD-PARTY module's schema (NSO-347): a
 * fixture config schema written in zod the way a company module would
 * (records of named entries, arrays of objects, enums, booleans, bounded
 * numbers, descriptions), rendered by the real `z.toJSONSchema` (input side,
 * like ModuleRuntime.configJsonSchema) and round-tripped through the form
 * inputs the renderer posts.
 */
import { describe, expect, it } from 'vitest';
import { z } from '@drobek/modules';
import {
  ENTRY_VALUE,
  MAX_ENTRY_DEPTH,
  blankEntryValues,
  entryInputs,
  fieldName,
  fieldValues,
  formToConfig,
  instancePath,
  isEntriesValue,
  leafFields,
  mergePatchBetween,
  optionInputName,
  schemaFields,
  type FieldValue,
  type FormField,
  type FormReader,
} from './module-config.js';

const ERP = z.strictObject({
  baseUrl: z.string().max(200).describe('The ERP API base URL'),
  timeoutMs: z.int().min(100).max(30_000).default(5000).describe('How long one call may take'),
  mode: z.enum(['sandbox', 'live']).default('sandbox'),
  verbose: z.boolean().default(false),
  scopes: z.array(z.string()).default([]),
  channels: z.array(z.enum(['email', 'sms', 'push'])).default(['email']),
  nickname: z.string().nullable().optional(),
  endpoints: z
    .record(
      z.string().regex(/^[a-z]+$/),
      z.strictObject({
        path: z.string().describe('Path under the base URL'),
        method: z.enum(['GET', 'POST']).default('GET'),
        retries: z.int().min(0).max(5).optional(),
        cache: z.boolean().default(true),
        headers: z.record(z.string(), z.string()).default({}),
      })
    )
    .default({})
    .describe('Named ERP endpoints the app may call'),
  mappings: z
    .array(
      z.strictObject({
        from: z.string(),
        to: z.string(),
        transforms: z.array(z.strictObject({ op: z.enum(['trim', 'upper']), args: z.array(z.string()).default([]) })).default([]),
      })
    )
    .default([]),
  labels: z.record(z.string(), z.string()).default({}),
  deep: z.record(z.string(), z.record(z.string(), z.record(z.string(), z.record(z.string(), z.string())))).default({}),
  anything: z.record(z.string(), z.unknown()).default({}),
});

const SCHEMA = z.toJSONSchema(ERP, { unrepresentable: 'any', io: 'input' });

type Config = z.input<typeof ERP>;

const CONFIG: Config = {
  baseUrl: 'https://erp.example/api',
  timeoutMs: 2500,
  mode: 'live',
  verbose: true,
  scopes: ['orders', 'stock'],
  channels: ['sms', 'push'],
  endpoints: {
    orders: { path: '/orders', method: 'GET', retries: 2, cache: false, headers: { 'X-Tenant': 'acme' } },
    stock: { path: '/stock', method: 'POST', cache: true, headers: {} },
  },
  mappings: [
    { from: 'sku', to: 'code', transforms: [{ op: 'trim', args: [] }, { op: 'upper', args: ['en'] }] },
    { from: 'qty', to: 'amount', transforms: [] },
  ],
  labels: { a: 'Alpha' },
  deep: { l1: { l2: { l3: { l4: 'bottom' } } } },
  anything: { x: [1, 2] },
};

/** The form a browser posts for rendered `values` (mirrors json-schema-form.tsx: every entry, then one untouched empty entry). */
function posted(fields: readonly FormField[], values: Record<string, FieldValue>, prefix = '', out = new Map<string, string>()): Map<string, string> {
  for (const f of leafFields(fields)) {
    const instance = instancePath(prefix, f.path);
    const v = values[f.path];
    if (f.kind === 'boolean') {
      if (v === true) out.set(fieldName(instance), 'on');
    } else if (f.kind === 'enum-list') {
      (f.options ?? []).forEach((o, j) => {
        if (Array.isArray(v) && v.includes(o)) out.set(optionInputName(instance, j), 'on');
      });
    } else if (f.kind === 'record' || f.kind === 'object-list') {
      const entries = isEntriesValue(v) ? v.entries : [];
      out.set(entryInputs.count(instance), String(entries.length + 1));
      entries.forEach((e, i) => {
        if (f.kind === 'record') out.set(entryInputs.key(instance, i), e.key ?? '');
        posted(f.entry ?? [], e.values, entryInputs.prefix(instance, i), out);
      });
      const n = entries.length;
      out.set(entryInputs.isNew(instance, n), '1');
      if (f.kind === 'record') out.set(entryInputs.key(instance, n), '');
      posted(f.entry ?? [], blankEntryValues(f), entryInputs.prefix(instance, n), out);
    } else {
      out.set(fieldName(instance), typeof v === 'string' ? v : '');
    }
  }
  return out;
}

function reader(m: Map<string, string>): FormReader {
  return { get: (n) => m.get(n) ?? null, has: (n) => m.has(n) };
}

const fields = schemaFields(SCHEMA);
const byPath = (list: readonly FormField[], path: string) => list.find((f) => f.path === path)!;

describe('schemaFields — a third-party schema', () => {
  it('maps records, arrays of objects, enums (single + multi), booleans, bounded numbers and descriptions', () => {
    expect(fields.map((f) => [f.path, f.kind, f.required])).toEqual([
      ['baseUrl', 'string', true],
      ['timeoutMs', 'integer', false],
      ['mode', 'enum', false],
      ['verbose', 'boolean', false],
      ['scopes', 'string-list', false],
      ['channels', 'enum-list', false],
      ['nickname', 'string', false],
      ['endpoints', 'record', false],
      ['mappings', 'object-list', false],
      ['labels', 'record', false],
      ['deep', 'record', false],
      ['anything', 'json', false],
    ]);
    expect(byPath(fields, 'baseUrl')).toMatchObject({ description: 'The ERP API base URL', maxLength: 200 });
    expect(byPath(fields, 'timeoutMs')).toMatchObject({ min: 100, max: 30_000, default: 5000, description: 'How long one call may take' });
    expect(byPath(fields, 'channels').options).toEqual(['email', 'sms', 'push']);
    expect(byPath(fields, 'endpoints').description).toBe('Named ERP endpoints the app may call');

    const endpoint = byPath(fields, 'endpoints').entry!;
    expect(endpoint.map((f) => [f.path, f.kind, f.required])).toEqual([
      ['path', 'string', true],
      ['method', 'enum', false],
      ['retries', 'integer', false],
      ['cache', 'boolean', false],
      ['headers', 'record', false],
    ]);
    expect(byPath(endpoint, 'path').description).toBe('Path under the base URL');
    expect(byPath(endpoint, 'headers').entry).toMatchObject([{ path: ENTRY_VALUE, kind: 'string', label: 'Value' }]);

    const mapping = byPath(fields, 'mappings').entry!;
    expect(mapping.map((f) => [f.path, f.kind])).toEqual([
      ['from', 'string'],
      ['to', 'string'],
      ['transforms', 'object-list'],
    ]);
    expect(byPath(mapping, 'transforms').entry!.map((f) => [f.path, f.kind])).toEqual([
      ['op', 'enum'],
      ['args', 'string-list'],
    ]);
  });

  it(`nests entries ${MAX_ENTRY_DEPTH} levels deep; below that a value is a JSON field`, () => {
    let f = byPath(fields, 'deep');
    const kinds: string[] = [];
    while (f.kind === 'record') {
      kinds.push(f.kind);
      f = f.entry![0];
    }
    expect(kinds).toHaveLength(MAX_ENTRY_DEPTH);
    expect(f).toMatchObject({ path: ENTRY_VALUE, kind: 'json' });
  });
});

describe('fieldValues / formToConfig — records and arrays of objects', () => {
  it('round-trips the whole config through the posted inputs (untouched empty entries add nothing)', () => {
    const values = fieldValues(fields, CONFIG);
    expect(values.endpoints).toEqual({
      entries: [
        {
          key: 'orders',
          values: { path: '/orders', method: 'GET', retries: '2', cache: false, headers: { entries: [{ key: 'X-Tenant', values: { [ENTRY_VALUE]: 'acme' } }] } },
        },
        { key: 'stock', values: { path: '/stock', method: 'POST', retries: '', cache: true, headers: { entries: [] } } },
      ],
    });
    const out = formToConfig(fields, reader(posted(fields, values)));
    expect(out.errors).toEqual({});
    expect(out.value).toEqual(CONFIG);
    expect(ERP.safeParse(out.value).success).toBe(true);
    // Re-shown values equal the rendered ones.
    expect(out.values).toEqual(values);
  });

  it('adds a record entry and a list item through the empty entry; removes by the checkbox; renames by the name', () => {
    const values = fieldValues(fields, CONFIG);
    const form = posted(fields, values);
    // A new endpoint in the empty entry (index 2) with a header of its own.
    form.set(entryInputs.key('endpoints', 2), 'invoices');
    form.set(fieldName('endpoints[2].path'), '/invoices');
    form.set(fieldName('endpoints[2].method'), 'POST');
    form.set(entryInputs.key('endpoints[2].headers', 0), 'Accept');
    form.set(fieldName('endpoints[2].headers[0].$value'), 'application/json');
    // Remove "stock", rename "orders" → "sales".
    form.set(entryInputs.remove('endpoints', 1), 'on');
    form.set(entryInputs.key('endpoints', 0), 'sales');
    // A third mapping; drop the first transform of the first mapping.
    form.set(fieldName('mappings[2].from'), 'price');
    form.set(fieldName('mappings[2].to'), 'amount');
    form.set(entryInputs.remove('mappings[0].transforms', 0), 'on');

    const out = formToConfig(fields, reader(form));
    expect(out.errors).toEqual({});
    const v = out.value as Config;
    expect(v.endpoints).toEqual({
      sales: CONFIG.endpoints!.orders,
      invoices: { path: '/invoices', method: 'POST', cache: true, headers: { Accept: 'application/json' } },
    });
    expect(v.mappings).toEqual([
      { from: 'sku', to: 'code', transforms: [{ op: 'upper', args: ['en'] }] },
      { from: 'qty', to: 'amount', transforms: [] },
      { from: 'price', to: 'amount', transforms: [] },
    ]);
    expect(ERP.safeParse(v).success).toBe(true);

    // The configure path gets a merge patch: the renamed / removed keys become null.
    expect(mergePatchBetween(CONFIG, v)).toMatchObject({
      endpoints: { orders: null, stock: null, sales: CONFIG.endpoints!.orders, invoices: expect.any(Object) },
    });
  });

  it('input errors inside an entry land on the top-level field, naming the entry; a nameless or duplicate entry is an error', () => {
    const values = fieldValues(fields, CONFIG);
    const form = posted(fields, values);
    form.set(fieldName('endpoints[0].retries'), 'two');
    form.set(fieldName('mappings[0].transforms[1].args'), 'x');
    let out = formToConfig(fields, reader(form));
    expect(out.errors).toEqual({ endpoints: '"orders" › retries: Enter a whole number.' });

    const nameless = posted(fields, values);
    nameless.set(fieldName('endpoints[2].path'), '/lost');
    out = formToConfig(fields, reader(nameless));
    expect(out.errors.endpoints).toMatch(/Name the new entry/);
    // …and the half-filled entry is re-shown, not lost.
    expect(isEntriesValue(out.values.endpoints) && out.values.endpoints.entries).toHaveLength(3);

    const dup = posted(fields, values);
    dup.set(entryInputs.key('endpoints', 1), 'orders');
    out = formToConfig(fields, reader(dup));
    expect(out.errors.endpoints).toMatch(/Two entries are named "orders"/);

    const nested = posted(fields, values);
    nested.set(fieldName('deep[0].$value[0].$value[0].$value'), '{ broken');
    out = formToConfig(fields, reader(nested));
    expect(out.errors.deep).toMatch(/^"l1" › "l2" › "l3": Not valid JSON/);
  });

  it('a forged entry count is capped; the empty entry starts from the schema defaults', () => {
    const f = byPath(fields, 'endpoints');
    expect(blankEntryValues(f)).toEqual({ path: '', method: 'GET', retries: '', cache: true, headers: { entries: [] } });
    const form = new Map([[entryInputs.count('labels'), '99999999']]);
    const out = formToConfig([byPath(fields, 'labels')], reader(form));
    expect(out.value).toEqual({ labels: {} });
  });
});
