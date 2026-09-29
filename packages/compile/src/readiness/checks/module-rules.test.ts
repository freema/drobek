import { describe, expect, it } from 'vitest';
import type { CheckFinding, ReadinessModule } from '../types.js';
import { moduleRules } from './module-rules.js';

const auth: ReadinessModule = { name: 'auth', enabled: true, config: {} };
const data = (collections: Record<string, unknown>, extra: Partial<ReadinessModule> = {}): ReadinessModule => ({
  name: 'data',
  enabled: true,
  config: { collections },
  ...extra,
});

const run = (...modules: ReadinessModule[]) => moduleRules.run({ files: new Map(), modules }) as CheckFinding[];
const codes = (...modules: ReadinessModule[]) => run(...modules).map((f) => f.code);

const bounded = {
  type: 'object',
  properties: { title: { type: 'string', maxLength: 200 }, done: { type: 'boolean' } },
  additionalProperties: false,
};

describe('module-rules check', () => {
  it('passes the defaults: no modules, empty configs, private collections with auth on', () => {
    expect(run()).toEqual([]);
    expect(run(auth, data({}))).toEqual([]);
    expect(run(auth, data({ todos: { rules: { read: 'owner|admin', create: 'user', update: 'owner|admin', delete: 'owner|admin' } } }))).toEqual([]);
    expect(run(auth, data({ todos: {} }))).toEqual([]);
  });

  it('reports a collection anyone may write without a schema, naming it and the configure_module fix', () => {
    const [f, ...rest] = run(auth, data({ guestbook: { rules: { read: 'public', create: 'public', update: 'admin', delete: 'admin' } } }));
    expect(rest).toEqual([]);
    expect(f.code).toBe('data_public_write_no_schema');
    expect(f.message).toContain('Collection "guestbook"');
    expect(f.message).toContain('create records');
    expect(f.message).toContain('configure_module({ app_id, module: "data", config: {"collections":{"guestbook":{"schema":');
    expect(f).not.toHaveProperty('file');
  });

  it('reports public write with unbounded strings or extra properties, and passes a bounded schema', () => {
    const rules = { read: 'admin', create: 'public', update: 'public', delete: 'admin' };
    expect(run(auth, data({ notes: { schema: bounded, rules } }))).toEqual([]);

    const loose = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        kind: { type: 'string', enum: ['a', 'b'] },
        tags: { type: 'array', items: { type: 'string' } },
        meta: { type: 'object', properties: { note: { type: ['string', 'null'] } } },
      },
    };
    const [f] = run(auth, data({ notes: { schema: loose, rules } }));
    expect(f.code).toBe('data_public_write_unbounded');
    expect(f.message).toContain('create and update records');
    expect(f.message).toContain('"name", "tags[]", "meta.note" have no maxLength');
    expect(f.message).toContain('accepts properties it does not list');
    expect(f.message).toContain('{"collections":{"notes":{"schema":{"properties":{"name":{"type":"string","maxLength":500}},"additionalProperties":false}}}}');
    expect(f.message).toContain('maxLength on "tags[]", "meta.note"');

    const onlyExtra = { type: 'object', properties: { title: { type: 'string', maxLength: 10 } } };
    const [g] = run(auth, data({ notes: { schema: onlyExtra, rules } }));
    expect(g.message).not.toContain('no maxLength');
    expect(g.message).toContain('{"schema":{"additionalProperties":false}}');
  });

  it('reports a public read of personal-looking fields, not of other fields', () => {
    const schema = {
      type: 'object',
      properties: {
        contactEmail: { type: 'string', maxLength: 200 },
        'phone-number': { type: 'string', maxLength: 30 },
        street_address: { type: 'string', maxLength: 200 },
        reply_to: { type: 'string', format: 'email', maxLength: 200 },
        emailVerified: { type: 'boolean' },
        title: { type: 'string', maxLength: 200 },
      },
      additionalProperties: false,
    };
    const [f, ...rest] = run(auth, data({ leads: { schema, rules: { read: 'public|admin', create: 'user' } } }));
    expect(rest).toEqual([]);
    expect(f.code).toBe('data_public_read_personal');
    expect(f.message).toContain('"contactEmail", "phone-number", "street_address", "reply_to"');
    expect(f.message).not.toContain('emailVerified');
    expect(f.message).toContain('{"collections":{"leads":{"rules":{"read":"owner|admin"}}}}');

    expect(run(auth, data({ posts: { schema: bounded, rules: { read: 'public' } } }))).toEqual([]);
    expect(run(auth, data({ leads: { schema, rules: { read: 'user' } } }))).toEqual([]);
  });

  it('reports sign-in rules when the auth module is missing or not enabled', () => {
    const collections = { todos: {}, wall: { schema: bounded, rules: { read: 'public', create: 'none', update: 'none', delete: 'admin' } } };
    const found = run(data(collections));
    expect(found.map((f) => f.code)).toEqual(['rule_needs_auth_module', 'rule_needs_auth_module']);
    expect(found[0].message).toContain('Collection "todos" needs a signed-in user to read, create, update, delete');
    expect(found[1].message).toContain('Collection "wall" needs a signed-in user to delete (rules.delete: "admin")');
    expect(found[1].message).toContain('{"collections":{"wall":{"rules":{"delete":"public"}}}}');

    expect(codes({ ...auth, enabled: false }, data(collections))).toEqual(['rule_needs_auth_module', 'rule_needs_auth_module']);
    expect(codes(auth, data(collections))).toEqual([]);
  });

  it('forms: only submit "user" without auth is reported (forms has no limit or captcha setting to check)', () => {
    const forms: ReadinessModule = {
      name: 'forms',
      enabled: true,
      config: { forms: { contact: { rules: { submit: 'public' } }, members: { rules: { submit: 'user' } } } },
    };
    expect(run(auth, forms)).toEqual([]);
    const [f, ...rest] = run(forms);
    expect(rest).toEqual([]);
    expect(f.code).toBe('rule_needs_auth_module');
    expect(f.message).toContain('Form "members"');
    expect(f.message).toContain('{"forms":{"members":{"rules":{"submit":"public"}}}}');
  });

  it('proxy: reports an upstream anonymous visitors may call, with or without a rateLimit', () => {
    const proxy = (upstreams: Record<string, unknown>): ReadinessModule => ({ name: 'proxy', enabled: true, config: { upstreams } });
    expect(run(auth, proxy({ crm: { rules: { call: 'user' } }, bare: {} }))).toEqual([]);

    const [f, g] = run(auth, proxy({ weather: { rules: { call: 'public' } }, maps: { rules: { call: 'public|admin' }, rateLimit: 20 } }));
    expect(f.code).toBe('proxy_public_upstream');
    expect(f.message).toContain('Upstream "maps"');
    expect(f.message).toContain('at most 20 calls a minute');
    expect(f.message).not.toContain('rateLimit');
    expect(g.message).toContain('Upstream "weather"');
    expect(g.message).toContain('{"upstreams":{"weather":{"rules":{"call":"user"}}}}');
    expect(g.message).toContain('{"upstreams":{"weather":{"rateLimit":30}}}');

    expect(codes(proxy({ crm: { rules: { call: 'user' } } }))).toEqual(['rule_needs_auth_module']);
  });

  it('lists every pending change of an enabled module, after the config findings', () => {
    const pending = ['data.collections.wall.rules.create: "user" → "public" (anyone, signed in or not, may add records)'];
    const found = run(data({ wall: { schema: bounded } }, { pending }), auth);
    expect(found).toEqual([
      {
        code: 'module_change_pending',
        message: expect.stringContaining(`A data change waits for the owner's confirmation and is not live yet: ${pending[0]}.`),
      },
    ]);
    expect(found[0].message).toContain('confirm_url from get_app (modules.data)');
  });

  it('ignores disabled modules and configs of an unexpected shape', () => {
    expect(run(auth, data({ wall: { rules: { create: 'public' } } }, { enabled: false, pending: ['x'] }))).toEqual([]);
    expect(run(auth, { name: 'data', enabled: true, config: null }, { name: 'proxy', enabled: true, config: { upstreams: [] } })).toEqual([]);
    expect(run(auth, data({ wall: 'nope', other: { rules: 7, schema: [] } }))).toEqual([]);
  });

  it('is deterministic: collections and upstreams are reported in name order', () => {
    const collections = { b: { rules: { create: 'public' } }, a: { rules: { create: 'public' } } };
    const one = run(auth, data(collections));
    expect(one.map((f) => f.message.slice(0, 15))).toEqual(['Collection "a" ', 'Collection "b" ']);
    expect(run(auth, data(collections))).toEqual(one);
  });
});
