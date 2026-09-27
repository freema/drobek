import { z } from '@drobek/modules';
import { describe, expect, it } from 'vitest';
import {
  fieldStates,
  fieldValues,
  formToConfig,
  leafFields,
  listRule,
  mergePatchBetween,
  needsValue,
  schemaFields,
  type FieldValue,
  type FormField,
  type FormReader,
} from './module-config.js';

/** An auth-shaped config: required lists that may be empty, a boolean that widens access, an optional string. */
const schema = z.strictObject({
  allow: z
    .strictObject({
      emails: z.array(z.string()).max(500).meta({ title: 'Allowed e-mail addresses', description: 'An empty list lets nobody in by address.' }),
      anyone: z.boolean().meta({ title: 'Anyone may sign in' }),
    })
    .meta({ title: 'Who may sign in' }),
  types: z.array(z.enum(['a', 'b'])).min(1).default(['a']),
  name: z.string().min(1).meta({ title: 'Name' }),
  note: z.string().optional(),
  retries: z.number().int().optional(),
});
const DEFAULTS = { allow: { emails: [], anyone: false }, types: ['a'], name: 'x' };
const fields = schemaFields(z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }));
const byPath = (path: string): FormField => leafFields(fields).find((f) => f.path === path)!;

/** The form exactly as the page renders it for `config` (checkboxes present only when checked). */
function renderedForm(config: unknown): FormReader {
  const values = fieldValues(fields, config);
  const inputs = new Map<string, string>();
  for (const f of leafFields(fields)) {
    const v: FieldValue | undefined = values[f.path];
    if (f.kind === 'boolean') {
      if (v === true) inputs.set(`cfg.${f.path}`, 'on');
    } else if (f.kind === 'enum-list') {
      (f.options ?? []).forEach((o, j) => {
        if (Array.isArray(v) && v.includes(o)) inputs.set(`cfg.${f.path}[${j}]`, 'on');
      });
    } else if (typeof v === 'string') {
      inputs.set(`cfg.${f.path}`, v);
    }
  }
  return inputs;
}

describe('schema labels', () => {
  it('uses the schema title and description, not the key', () => {
    expect(byPath('allow.emails')).toMatchObject({ label: 'Allowed e-mail addresses', description: 'An empty list lets nobody in by address.' });
    expect(fields[0]).toMatchObject({ kind: 'object', label: 'Who may sign in' });
  });

  it('reads the item bounds of a list and ignores the ±MAX_SAFE_INTEGER bounds of a plain integer', () => {
    expect(byPath('allow.emails')).toMatchObject({ maxItems: 500 });
    expect(byPath('allow.emails').minItems).toBeUndefined();
    expect(byPath('types')).toMatchObject({ minItems: 1 });
    expect(byPath('retries').min).toBeUndefined();
    expect(byPath('retries').max).toBeUndefined();
  });
});

describe('required mark vs a list that must not be empty', () => {
  it('marks a required text field only — a required list or checkbox is always sent', () => {
    expect(byPath('allow.emails').required).toBe(true);
    expect(needsValue(byPath('allow.emails'))).toBe(false);
    expect(needsValue(byPath('allow.anyone'))).toBe(false);
    expect(needsValue(byPath('name'))).toBe(true);
    expect(needsValue(byPath('note'))).toBe(false);
  });

  it('says whether a list can be left empty and how many items it takes', () => {
    expect(listRule(byPath('allow.emails'))).toBe('Can be left empty. At most 500 items.');
    expect(listRule(byPath('types'))).toBe('Needs at least 1 item.');
    expect(listRule(byPath('name'))).toBeNull();
    expect(listRule({ path: 'forms', key: 'forms', label: 'Forms', kind: 'record', required: false })).toBe('Can be left empty.');
  });
});

describe('an unchanged form keeps defaults, empty lists, false and absent values', () => {
  it('produces no patch: nothing is saved, no access is granted', () => {
    const r = formToConfig(fields, renderedForm(DEFAULTS));
    expect(r.errors).toEqual({});
    expect(r.value).toEqual({ allow: { emails: [], anyone: false }, types: ['a'], name: 'x' });
    expect('note' in r.value).toBe(false);
    expect('retries' in r.value).toBe(false);
    expect(mergePatchBetween(DEFAULTS, r.value)).toBeUndefined();
  });

  it('a cleared optional value is removed (null in the patch), an emptied list stays an empty list', () => {
    const config = { ...DEFAULTS, allow: { emails: ['a@example.com'], anyone: false }, note: 'hi' };
    const form = renderedForm(config) as Map<string, string>;
    form.set('cfg.note', '');
    form.set('cfg.allow.emails', '');
    const r = formToConfig(fields, form);
    expect(mergePatchBetween(config, r.value)).toEqual({ allow: { emails: [] }, note: null });
  });

  it('only a checked box turns a boolean on', () => {
    const form = renderedForm(DEFAULTS) as Map<string, string>;
    expect(form.has('cfg.allow.anyone')).toBe(false);
    form.set('cfg.allow.anyone', 'on');
    expect(mergePatchBetween(DEFAULTS, formToConfig(fields, form).value)).toEqual({ allow: { anyone: true } });
  });
});

describe('fieldStates', () => {
  it('tells the module default from a value saved for the app', () => {
    const s = fieldStates(fields, { stored: { allow: { emails: [] } }, config: DEFAULTS });
    expect(s['allow.emails']).toEqual({ origin: 'saved' });
    expect(s['allow.anyone']).toEqual({ origin: 'default' });
    expect(s['note']).toEqual({ origin: 'default' });
  });

  it('shows the value after confirming only on the fields the pending change touches', () => {
    const after = { ...DEFAULTS, allow: { emails: [], anyone: true } };
    const s = fieldStates(fields, { stored: {}, config: DEFAULTS, pendingAfter: after });
    expect(s['allow.anyone']).toEqual({ origin: 'default', pending: 'true' });
    expect(s['allow.emails'].pending).toBeUndefined();
  });

  it('a pending change that no longer validates (after = null) marks nothing', () => {
    const s = fieldStates(fields, { stored: {}, config: DEFAULTS, pendingAfter: null });
    expect(Object.values(s).some((x) => x.pending !== undefined)).toBe(false);
  });

  it('shows a value the change removes as not set, and shortens a long one', () => {
    const config = { ...DEFAULTS, note: 'hi' };
    const long = 'x'.repeat(300);
    expect(fieldStates(fields, { stored: { note: 'hi' }, config, pendingAfter: DEFAULTS })['note'].pending).toBe('(not set)');
    const s = fieldStates(fields, { stored: {}, config, pendingAfter: { ...config, note: long } });
    expect(s['note'].pending).toHaveLength(120);
    expect(s['note'].pending?.endsWith('…')).toBe(true);
  });
});
