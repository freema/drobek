import { describe, expect, it } from 'vitest';
import {
  confirmRoleOf,
  configDiff,
  fieldErrors,
  fieldName,
  fieldValues,
  formToConfig,
  leafFields,
  mergePatchBetween,
  principalsToRule,
  riskNote,
  ruleFromForm,
  ruleInputName,
  ruleToPrincipals,
  schemaFields,
  type FormReader,
} from './module-config.js';

/** The auth module's config schema as zod renders it (input side). */
const AUTH_SCHEMA = {
  type: 'object',
  properties: {
    allow: {
      type: 'object',
      properties: {
        emails: { maxItems: 500, type: 'array', items: { type: 'string', maxLength: 254 } },
        domains: { type: 'array', items: { type: 'string' } },
        anyone: { type: 'boolean' },
      },
      required: ['emails', 'domains', 'anyone'],
    },
    adminEmails: { type: 'array', items: { type: 'string' } },
  },
  required: ['allow', 'adminEmails'],
};

const MIXED_SCHEMA = {
  type: 'object',
  properties: {
    fromName: { type: 'string', minLength: 1, maxLength: 60, title: 'Sender name', description: 'Shown as the sender' },
    level: { type: 'string', enum: ['low', 'high'] },
    count: { type: 'integer', minimum: 1, maximum: 10 },
    ratio: { type: 'number' },
    forms: { type: 'object', propertyNames: { type: 'string' }, additionalProperties: { type: 'object' } },
    collections: { type: 'object', additionalProperties: {} },
  },
  required: ['level'],
};

function form(entries: Record<string, string>): FormReader {
  const m = new Map(Object.entries(entries));
  return { get: (n) => m.get(n) ?? null, has: (n) => m.has(n) };
}

describe('schemaFields', () => {
  it('maps the subset the modules use; records become JSON fields; skip leaves dedicated keys out', () => {
    const fields = schemaFields(MIXED_SCHEMA, ['collections']);
    expect(fields.map((f) => [f.path, f.kind, f.required])).toEqual([
      ['fromName', 'string', false],
      ['level', 'enum', true],
      ['count', 'integer', false],
      ['ratio', 'number', false],
      ['forms', 'json', false],
    ]);
    expect(fields[0]).toMatchObject({ label: 'Sender name', description: 'Shown as the sender', maxLength: 60 });
    expect(fields[1].options).toEqual(['low', 'high']);
    expect(fields[2]).toMatchObject({ min: 1, max: 10, label: 'Count' });
  });

  it('nested objects and string lists', () => {
    const fields = schemaFields(AUTH_SCHEMA);
    expect(leafFields(fields).map((f) => [f.path, f.kind, f.label])).toEqual([
      ['allow.emails', 'string-list', 'Emails'],
      ['allow.domains', 'string-list', 'Domains'],
      ['allow.anyone', 'boolean', 'Anyone'],
      ['adminEmails', 'string-list', 'Admin emails'],
    ]);
    expect(schemaFields(null)).toEqual([]);
    expect(schemaFields({ type: 'string' })).toEqual([]);
  });
});

describe('fieldValues / formToConfig', () => {
  it('round-trips a config through the inputs', () => {
    const fields = schemaFields(AUTH_SCHEMA);
    const config = { allow: { emails: ['a@example.com', 'b@example.com'], domains: [], anyone: false }, adminEmails: ['a@example.com'] };
    const values = fieldValues(fields, config);
    expect(values).toEqual({
      'allow.emails': 'a@example.com\nb@example.com',
      'allow.domains': '',
      'allow.anyone': false,
      adminEmails: 'a@example.com',
    });
    const out = formToConfig(
      fields,
      form({
        [fieldName('allow.emails')]: ' a@example.com \r\n\r\nc@example.com',
        [fieldName('allow.domains')]: '',
        [fieldName('allow.anyone')]: 'on',
        [fieldName('adminEmails')]: '',
      })
    );
    expect(out.errors).toEqual({});
    expect(out.value).toEqual({ allow: { emails: ['a@example.com', 'c@example.com'], domains: [], anyone: true }, adminEmails: [] });
  });

  it('empty optional fields are left out; required ones stay empty (the schema decides); bad numbers and JSON are errors', () => {
    const fields = schemaFields(MIXED_SCHEMA, ['collections']);
    const out = formToConfig(
      fields,
      form({
        [fieldName('fromName')]: '',
        [fieldName('level')]: '',
        [fieldName('count')]: '2.5',
        [fieldName('ratio')]: ' 0.5 ',
        [fieldName('forms')]: '{ broken',
      })
    );
    expect(out.value).toEqual({ level: '', ratio: 0.5 });
    expect(Object.keys(out.errors)).toEqual(['count', 'forms']);
    expect(out.errors.count).toBe('Enter a whole number.');
    expect(out.errors.forms).toMatch(/^Not valid JSON/);
    expect(out.values.count).toBe('2.5');
    const json = formToConfig(fields, form({ [fieldName('level')]: 'low', [fieldName('forms')]: '{"contact":{}}' }));
    expect(json.value).toEqual({ level: 'low', forms: { contact: {} } });
  });
});

describe('mergePatchBetween', () => {
  it('changed keys, removed keys (null), nested objects, whole arrays; undefined when equal', () => {
    const before = { greeting: 'Hello', excited: false, allow: { emails: ['a'], anyone: false }, replyTo: 'x@example.com' };
    const after = { greeting: 'Hello', excited: true, allow: { emails: ['a', 'b'], anyone: false } };
    expect(mergePatchBetween(before, after)).toEqual({ excited: true, allow: { emails: ['a', 'b'] }, replyTo: null });
    expect(mergePatchBetween(before, structuredClone(before))).toBeUndefined();
    expect(mergePatchBetween({ c: {} }, { c: { notes: { rules: { read: 'public' } } } })).toEqual({ c: { notes: { rules: { read: 'public' } } } });
    expect(mergePatchBetween({ a: 1 }, { a: 1, b: undefined })).toBeUndefined();
  });
});

describe('configDiff', () => {
  it('lists every changed leaf path, before → after', () => {
    const before = { collections: { notes: { rules: { read: 'owner|admin', create: 'user' } } }, greeting: 'Hello' };
    const after = { collections: { notes: { rules: { read: 'owner|admin', create: 'public' } }, todo: { rules: { read: 'public' } } }, greeting: 'Hello' };
    expect(configDiff(before, after)).toEqual([
      { path: 'collections.notes.rules.create', before: '"user"', after: '"public"' },
      { path: 'collections.todo.rules.read', before: '(not set)', after: '"public"' },
    ]);
    expect(configDiff({ upstreams: {} }, { upstreams: { weather: { rules: { call: 'user' } } } })).toEqual([
      { path: 'upstreams.weather.rules.call', before: '(not set)', after: '"user"' },
    ]);
    expect(configDiff({ replyTo: 'a@example.com' }, {})).toEqual([{ path: 'replyTo', before: '"a@example.com"', after: '(not set)' }]);
    expect(configDiff({ a: [1] }, { a: [1] })).toEqual([]);
  });
});

describe('fieldErrors', () => {
  it('maps bracketed issue paths to the nearest field; the rest is general', () => {
    const out = fieldErrors(
      [
        { path: 'allow.emails[0]', message: 'must be an e-mail address' },
        { path: 'greeting', message: 'Too small' },
        { path: 'forms.contact.notify.emails[1]', message: 'must be an e-mail address' },
        { path: '(root)', message: 'Unrecognized key' },
        { path: 'mystery', message: 'nope' },
      ],
      ['allow.emails', 'greeting', 'forms']
    );
    expect(out.fields).toEqual({
      'allow.emails': ['[0]: must be an e-mail address'],
      greeting: ['Too small'],
      forms: ['contact.notify.emails[1]: must be an e-mail address'],
    });
    expect(out.general).toEqual(['Unrecognized key', 'mystery: nope']);
  });
});

describe('rules', () => {
  it('rule ⇄ principal checkboxes, canonical order, none', () => {
    expect(ruleToPrincipals('admin|owner')).toEqual(['owner', 'admin']);
    expect(ruleToPrincipals('none')).toEqual([]);
    expect(ruleToPrincipals(undefined)).toEqual([]);
    expect(principalsToRule(['admin', 'owner'])).toBe('owner|admin');
    expect(principalsToRule([])).toBe('none');
    expect(principalsToRule(['public', 'bogus'])).toBe('public');
    const f = form({ [ruleInputName('create', 'public')]: 'on', [ruleInputName('create', 'user')]: 'on', [ruleInputName('read', 'owner')]: 'on' });
    expect(ruleFromForm(f, 'create')).toBe('public|user');
    expect(ruleFromForm(f, 'read')).toBe('owner');
    expect(ruleFromForm(f, 'delete')).toBe('none');
    expect(ruleFromForm(f, 'create', ['user', 'admin'])).toBe('user');
  });

  it('riskNote: plain language per kind of change', () => {
    expect(riskNote('data.collections.notes.rules.create: "user" → "public" (anyone, signed in or not, may add records)')).toMatch(/anyone on the internet/);
    expect(riskNote('allow.anyone: false → true (anyone with an e-mail address can sign in to this app)')).toMatch(/Anyone with an e-mail address/);
    expect(riskNote('proxy.upstreams.weather: this app may call the workspace upstream "weather" with its secret (callers: "user")')).toMatch(/external service/);
    expect(riskNote('replyTo: (none) → boss@example.com (replies to this app\'s e-mails go there)')).toMatch(/E-mail/);
    expect(riskNote('data.collections.notes.rules.update: "owner|admin" → "user" (every signed-in user may change every record, not only their own)')).toMatch(/other users/);
    expect(riskNote('greeting: "Hello" → "Ahoj"')).toMatch(/waits for your approval/);
  });
});

describe('confirmRoleOf (NSO-322 H3)', () => {
  it('only a workspace admin (super-admins arrive as one) confirms admin-only changes', () => {
    expect(confirmRoleOf('workspace-admin')).toBe('admin');
    expect(confirmRoleOf('editor')).toBe('editor');
    expect(confirmRoleOf('viewer')).toBe('editor');
    expect(confirmRoleOf(null)).toBe('editor');
  });
});
