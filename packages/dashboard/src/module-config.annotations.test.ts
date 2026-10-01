/**
 * The config-form keywords beyond choices (ConfigFieldMeta, through the real
 * `z.toJSONSchema`, input side): `x-drobek-rule` (principal checkboxes),
 * `x-drobek-unit: 'bytes'` (entered in MB), `x-drobek-default-limit`,
 * `x-drobek-hidden` (carried through a save unseen), `x-drobek-order` and
 * `x-drobek-choices` on a record's entry names. Each changes only how a
 * field is shown and read back: the value the form posts for an untouched
 * field is the value in force.
 */
import { describe, expect, it } from 'vitest';
import { z, type ConfigFieldMeta } from '@drobek/modules';
import {
  BYTES_PER_MB,
  choiceRequests,
  defaultLimitNames,
  entryInputs,
  fieldName,
  fieldValues,
  formToConfig,
  mbLabel,
  mergePatchBetween,
  needsValue,
  ruleInputs,
  schemaFields,
  type FieldValue,
  type FormField,
  type FormReader,
} from './module-config.js';

const rule = z.string().regex(/^(public|user|owner|admin|none)(\|(public|user|owner|admin|none))*$/);

const ITEM = z.strictObject({
  url: z.string(),
  paused: z.boolean().optional().meta({ title: 'Paused', 'x-drobek-hidden': true } satisfies ConfigFieldMeta),
});

const SCHEMA = z.strictObject({
  rules: z
    .strictObject({
      upload: rule.default('user').meta({ title: 'Who may upload', 'x-drobek-rule': ['public', 'user', 'admin'] } satisfies ConfigFieldMeta),
      read: rule.default('user').meta({ title: 'Who may download', 'x-drobek-rule': true } satisfies ConfigFieldMeta),
    })
    .default({ upload: 'user', read: 'user' }),
  extra: rule.optional().meta({ 'x-drobek-rule': true } satisfies ConfigFieldMeta),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(1024 * BYTES_PER_MB)
    .optional()
    .meta({ title: 'Largest file', 'x-drobek-unit': 'bytes', 'x-drobek-default-limit': 'FILES_MAX_BYTES' } satisfies ConfigFieldMeta),
  items: z.record(z.string().meta({ title: 'Item', 'x-drobek-choices': 'forms' } satisfies ConfigFieldMeta), ITEM).default({}),
  provider: z
    .strictObject({ issuer: z.string().optional(), clientId: z.string().optional(), enabled: z.boolean(), note: z.string().optional() })
    .meta({ title: 'Provider', 'x-drobek-order': ['enabled', 'missing', 'note'] } satisfies ConfigFieldMeta),
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

/** The form exactly as the renderer posts it for `config` (checked boxes, the shown rule, hidden values, every text). */
function posted(list: readonly FormField[], config: unknown, change: Record<string, string | null> = {}): Record<string, string> {
  const values = fieldValues(list, config);
  const out: Record<string, string> = {};
  const put = (fs: readonly FormField[], vals: Record<string, FieldValue>, prefix: string) => {
    for (const f of fs) {
      if (f.kind === 'object') {
        put(f.children ?? [], vals, prefix);
        continue;
      }
      const instance = prefix ? `${prefix}.${f.path}` : f.path;
      const v = vals[f.path];
      if (f.kind === 'rule') {
        const rule = typeof v === 'string' ? v : '';
        out[ruleInputs.shown(instance)] = rule;
        for (const p of rule.split('|')) if (p && p !== 'none') out[ruleInputs.principal(instance, p as 'public')] = 'on';
      } else if (f.kind === 'boolean') {
        if (v === true) out[fieldName(instance)] = 'on';
      } else if (f.kind === 'record') {
        const entries = typeof v === 'object' && !Array.isArray(v) ? v.entries : [];
        out[entryInputs.count(instance)] = String(entries.length);
        entries.forEach((e, i) => {
          out[entryInputs.key(instance, i)] = e.key ?? '';
          put(f.entry ?? [], e.values, entryInputs.prefix(instance, i));
        });
      } else if (typeof v === 'string') {
        out[fieldName(instance)] = v;
      }
    }
  };
  put(list, values, '');
  for (const [k, v] of Object.entries(change)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

const CONFIG = {
  rules: { upload: 'admin|user', read: 'owner|admin' },
  maxBytes: 5_000_000,
  items: { feed: { url: 'https://x.example', paused: true }, news: { url: 'https://y.example' } },
  provider: { enabled: false },
};

describe('x-drobek-rule', () => {
  it('a rule string is a rule field offering the listed principals (true: all four); no * mark — nothing checked is none', () => {
    const list = fields();
    const rules = byPath(list, 'rules').children ?? [];
    expect(byPath(rules, 'rules.upload')).toMatchObject({ kind: 'rule', principals: ['public', 'user', 'admin'], default: 'user' });
    expect(byPath(rules, 'rules.read')).toMatchObject({ kind: 'rule', principals: ['public', 'user', 'owner', 'admin'] });
    expect(needsValue({ ...byPath(rules, 'rules.read'), required: true })).toBe(false);
    const odd = schemaFields(
      z.toJSONSchema(z.strictObject({ a: rule.meta({ 'x-drobek-rule': ['root'] as never }), b: z.int().meta({ 'x-drobek-rule': true }) }), { io: 'input' })
    );
    expect(byPath(odd, 'a').kind).toBe('string');
    expect(byPath(odd, 'b').kind).toBe('integer');
  });

  it('an untouched rule saves as written; other principals make the canonical rule; nothing checked is none', () => {
    const list = fields();
    const same = formToConfig(list, reader(posted(list, CONFIG)));
    expect(same.errors).toEqual({});
    expect(same.value.rules).toEqual({ upload: 'admin|user', read: 'owner|admin' });
    expect(mergePatchBetween(CONFIG, { ...CONFIG, ...same.value })).toBeUndefined();

    const changed = formToConfig(
      list,
      reader(posted(list, CONFIG, { [ruleInputs.principal('rules.upload', 'public')]: 'on', [ruleInputs.principal('rules.read', 'owner')]: null, [ruleInputs.principal('rules.read', 'admin')]: null }))
    );
    expect(changed.value.rules).toEqual({ upload: 'public|user|admin', read: 'none' });
    expect(changed.values['rules.upload']).toBe('public|user|admin');
  });

  it('an optional rule without a value stays unset while nothing is checked', () => {
    const list = fields();
    const parsed = formToConfig(list, reader(posted(list, CONFIG)));
    expect(parsed.value).not.toHaveProperty('extra');
    expect(parsed.values.extra).toBe('');
    const set = formToConfig(list, reader(posted(list, CONFIG, { [ruleInputs.principal('extra', 'user')]: 'on' })));
    expect(set.value.extra).toBe('user');
  });
});

describe("x-drobek-unit: 'bytes'", () => {
  it('a bytes field shows MB — exactly, so an untouched odd value saves the same bytes', () => {
    const list = fields();
    expect(byPath(list, 'maxBytes')).toMatchObject({ kind: 'integer', unit: 'bytes', defaultLimit: 'FILES_MAX_BYTES', max: 1024 * BYTES_PER_MB });
    expect(fieldValues(list, { maxBytes: 5 * BYTES_PER_MB }).maxBytes).toBe('5');
    expect(fieldValues(list, { maxBytes: BYTES_PER_MB / 2 }).maxBytes).toBe('0.5');
    expect(fieldValues(list, {}).maxBytes).toBe('');
    for (const bytes of [5_000_000, 1, 1_073_741_823, 123_456_789]) {
      const parsed = formToConfig(list, reader(posted(list, { ...CONFIG, maxBytes: bytes })));
      expect(parsed.value.maxBytes, String(bytes)).toBe(bytes);
    }
  });

  it('MB typed in become whole bytes; text, too much or nothing at all is refused in MB words; empty leaves the key out', () => {
    const list = fields();
    const at = (text: string) => formToConfig(list, reader(posted(list, CONFIG, { [fieldName('maxBytes')]: text })));
    expect(at('25').value.maxBytes).toBe(25 * BYTES_PER_MB);
    expect(at(' 0.5 ').value.maxBytes).toBe(BYTES_PER_MB / 2);
    expect(at('4.77').value.maxBytes).toBe(Math.round(4.77 * BYTES_PER_MB));
    expect(at('').value).not.toHaveProperty('maxBytes');
    expect(at('five').errors).toEqual({ maxBytes: 'Enter a size in MB, like 5 or 0.5.' });
    expect(at('2048').errors).toEqual({ maxBytes: 'At most 1024 MB.' });
    expect(at('0').errors).toEqual({ maxBytes: 'Enter more than 0 MB.' });
    expect(at('2048').values.maxBytes).toBe('2048');
  });

  it('mbLabel rounds to two decimals; defaultLimitNames lists the limits empty fields stand for, once', () => {
    expect(mbLabel(25 * BYTES_PER_MB)).toBe('25 MB');
    expect(mbLabel(5_000_000)).toBe('4.77 MB');
    expect(defaultLimitNames(fields())).toEqual(['FILES_MAX_BYTES']);
    expect(defaultLimitNames(schemaFields(z.toJSONSchema(z.strictObject({ a: z.string() }), { io: 'input' })))).toEqual([]);
  });
});

describe('x-drobek-hidden', () => {
  it('a hidden field carries its value as JSON through a save, whatever it is — and leaves an unset one unset', () => {
    const list = fields();
    const item = byPath(byPath(list, 'items').entry ?? [], 'paused');
    expect(item).toMatchObject({ kind: 'json', hidden: true, required: false });
    expect(needsValue({ ...item, required: true })).toBe(false);
    const values = fieldValues(list, CONFIG).items;
    expect(values).toMatchObject({ entries: [{ key: 'feed', values: { paused: 'true' } }, { key: 'news', values: { paused: '' } }] });
    const parsed = formToConfig(list, reader(posted(list, CONFIG)));
    expect(parsed.errors).toEqual({});
    expect(parsed.value.items).toEqual(CONFIG.items);
    expect(mergePatchBetween(CONFIG, { ...CONFIG, ...parsed.value })).toBeUndefined();
  });
});

describe('x-drobek-order', () => {
  it("an object's listed keys come first in that order (unknown keys ignored), the rest keep the schema's order", () => {
    expect((byPath(fields(), 'provider').children ?? []).map((f) => f.key)).toEqual(['enabled', 'note', 'issuer', 'clientId']);
    const list = fields();
    const parsed = formToConfig(list, reader(posted(list, CONFIG, { [fieldName('provider.enabled')]: 'on' })));
    expect(parsed.value.provider).toEqual({ enabled: true });
  });
});

describe("x-drobek-choices on a record's entry names", () => {
  it('the entry name carries the source; the form requests the list once', () => {
    expect(byPath(fields(), 'items').entryKey).toEqual({ label: 'Item', choices: 'forms' });
    expect(choiceRequests(fields())).toEqual([{ key: 'forms', from: 'forms' }]);
    const bare = z.strictObject({ m: z.record(z.string().meta({ 'x-drobek-choices': 'forms' } satisfies ConfigFieldMeta), z.number()) });
    expect(byPath(schemaFields(z.toJSONSchema(bare, { io: 'input' })), 'm').entryKey).toEqual({ label: 'Name', choices: 'forms' });
  });
});
