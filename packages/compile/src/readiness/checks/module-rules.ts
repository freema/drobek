import type { CheckFinding, ReadinessCheck, ReadinessModule } from '../types.js';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The tokens of a module rule (`public|user|owner|admin|none` joined with `|`). */
function tokens(rule: unknown): Set<string> {
  return new Set(typeof rule === 'string' ? rule.split('|').map((t) => t.trim()) : []);
}

const isPublic = (rule: unknown) => tokens(rule).has('public');

/** A rule only a signed-in end user satisfies: it names a signed-in role and not `public`. */
function needsSignIn(rule: unknown): boolean {
  const t = tokens(rule);
  return !t.has('public') && (t.has('user') || t.has('owner') || t.has('admin'));
}

function fix(module: string, config: unknown): string {
  return `configure_module({ app_id, module: "${module}", config: ${JSON.stringify(config)} })`;
}

const quoted = (names: readonly string[]) => names.map((n) => `"${n}"`).join(', ');

/** What a collection that leaves a rule out gets (modules/data DEFAULT_RULES). */
const DATA_DEFAULT_RULES: Obj = { read: 'owner|admin', create: 'user', update: 'owner|admin', delete: 'owner|admin' };
const DATA_OPS = ['read', 'create', 'update', 'delete'] as const;
const WRITE_OPS = ['create', 'update'] as const;
const SUGGESTED_MAX_LENGTH = 500;
const MAX_SCHEMA_DEPTH = 6;

/** String fields without a length bound (no maxLength, enum or const), as dotted paths (`[]` = array items). */
function unboundedStrings(schema: unknown, path = '', out: string[] = [], depth = 0): string[] {
  if (!isObj(schema) || depth > MAX_SCHEMA_DEPTH) return out;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const bounded = typeof schema.maxLength === 'number' || Array.isArray(schema.enum) || 'const' in schema;
  if (path && types.includes('string') && !bounded) out.push(path);
  if (isObj(schema.properties)) {
    for (const [key, sub] of Object.entries(schema.properties)) unboundedStrings(sub, path ? `${path}.${key}` : key, out, depth + 1);
  }
  if (isObj(schema.items)) unboundedStrings(schema.items, `${path}[]`, out, depth + 1);
  return out;
}

const PERSONAL_NAMES = [/e_?mail/, /phone|mobile|^tel$|^tel_|_tel$/, /address|street|^city$|^zip$|zip_?code|post_?code|postal/];

/** Top-level fields that look like an e-mail, phone or postal address (by name or `format: "email"`). */
function personalFields(schema: unknown): string[] {
  if (!isObj(schema) || !isObj(schema.properties)) return [];
  const out: string[] = [];
  for (const [key, sub] of Object.entries(schema.properties)) {
    const s = isObj(sub) ? sub : {};
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (types.length > 0 && types.every((t) => t === 'boolean' || t === 'number' || t === 'integer')) continue;
    const name = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase();
    if (s.format === 'email' || PERSONAL_NAMES.some((re) => re.test(name))) out.push(key);
  }
  return out;
}

const NO_AUTH = 'but the auth module is not active for this app, so nobody can sign in';
const ENABLE_AUTH = 'ask the server operator to enable the auth module for this workspace';

function dataFindings(config: Obj, authOn: boolean): CheckFinding[] {
  const out: CheckFinding[] = [];
  const collections = isObj(config.collections) ? config.collections : {};
  for (const name of Object.keys(collections).sort()) {
    const c = isObj(collections[name]) ? collections[name] : {};
    const rules: Obj = { ...DATA_DEFAULT_RULES, ...(isObj(c.rules) ? c.rules : {}) };
    const schema = isObj(c.schema) ? c.schema : undefined;
    const publicWrite = WRITE_OPS.filter((op) => isPublic(rules[op]));
    const who = `Collection "${name}" lets anyone, signed in or not, ${publicWrite.join(' and ')} records`;

    if (publicWrite.length > 0 && !schema) {
      const example = {
        type: 'object',
        properties: { '<field>': { type: 'string', maxLength: SUGGESTED_MAX_LENGTH } },
        required: ['<field>'],
        additionalProperties: false,
      };
      out.push({
        code: 'data_public_write_no_schema',
        message: `${who}, and it has no schema: any shape and any amount of text is stored. Fix: ${fix('data', { collections: { [name]: { schema: example } } })} with the fields the app really sends.`,
      });
    } else if (publicWrite.length > 0 && schema) {
      const loose = unboundedStrings(schema);
      const extra = schema.additionalProperties !== false;
      if (loose.length > 0 || extra) {
        const top = loose.filter((p) => !p.includes('.') && !p.includes('['));
        const nested = loose.filter((p) => !top.includes(p));
        const properties = Object.fromEntries(top.map((f) => [f, { type: 'string', maxLength: SUGGESTED_MAX_LENGTH }]));
        const patch = { ...(top.length > 0 ? { properties } : {}), ...(extra ? { additionalProperties: false } : {}) };
        const what = [
          loose.length > 0 ? `the string field${loose.length === 1 ? '' : 's'} ${quoted(loose)} ${loose.length === 1 ? 'has' : 'have'} no maxLength` : '',
          extra ? 'the schema accepts properties it does not list' : '',
        ]
          .filter(Boolean)
          .join(' and ');
        const tail = nested.length > 0 ? `${Object.keys(patch).length > 0 ? ', and a' : 'Add a'} maxLength on ${quoted(nested)} in the same schema` : '';
        out.push({
          code: 'data_public_write_unbounded',
          message: `${who}, and ${what}. Fix: ${Object.keys(patch).length > 0 ? fix('data', { collections: { [name]: { schema: patch } } }) : ''}${tail} (keep the types you have; merge into the existing schema).`,
        });
      }
    }

    if (isPublic(rules.read)) {
      const personal = personalFields(schema);
      if (personal.length > 0) {
        out.push({
          code: 'data_public_read_personal',
          message: `Collection "${name}" is readable by anyone, signed in or not (rules.read: "${String(rules.read)}"), and holds personal data in ${quoted(personal)}: every visitor can list it. Fix: ${fix('data', { collections: { [name]: { rules: { read: 'owner|admin' } } } })}, or move those fields to a collection that is not public.`,
        });
      }
    }

    if (!authOn) {
      const ops = DATA_OPS.filter((op) => needsSignIn(rules[op]));
      if (ops.length > 0) {
        const opened = Object.fromEntries(ops.map((op) => [op, 'public']));
        out.push({
          code: 'rule_needs_auth_module',
          message: `Collection "${name}" needs a signed-in user to ${ops.join(', ')} (${ops.map((op) => `rules.${op}: "${String(rules[op])}"`).join(', ')}), ${NO_AUTH} and those calls answer 401. Fix: ${ENABLE_AUTH}; or, only for what visitors may do without an account, ${fix('data', { collections: { [name]: { rules: opened } } })} (it waits for the owner's confirmation).`,
        });
      }
    }
  }
  return out;
}

function formsFindings(config: Obj, authOn: boolean): CheckFinding[] {
  if (authOn) return [];
  const forms = isObj(config.forms) ? config.forms : {};
  return Object.keys(forms)
    .sort()
    .filter((name) => {
      const f = forms[name];
      return isObj(f) && isObj(f.rules) && f.rules.submit === 'user';
    })
    .map((name) => ({
      code: 'rule_needs_auth_module',
      message: `Form "${name}" takes submissions only from signed-in users (rules.submit: "user"), ${NO_AUTH} and every submission answers 401. Fix: ${ENABLE_AUTH}, or ${fix('forms', { forms: { [name]: { rules: { submit: 'public' } } } })}.`,
    }));
}

function proxyFindings(config: Obj, authOn: boolean): CheckFinding[] {
  const out: CheckFinding[] = [];
  const upstreams = isObj(config.upstreams) ? config.upstreams : {};
  for (const name of Object.keys(upstreams).sort()) {
    const a = isObj(upstreams[name]) ? upstreams[name] : {};
    const call = isObj(a.rules) && typeof a.rules.call === 'string' ? a.rules.call : 'user';
    if (isPublic(call)) {
      const rate = typeof a.rateLimit === 'number' ? a.rateLimit : undefined;
      const cap = rate === undefined ? `, or cap it with ${fix('proxy', { upstreams: { [name]: { rateLimit: 30 } } })}` : '';
      out.push({
        code: 'proxy_public_upstream',
        message: `Upstream "${name}" can be called by anyone, signed in or not (rules.call: "${call}"): every visitor uses its credentials and quota, ${rate === undefined ? 'limited only per client IP and by the app-wide proxy limit' : `at most ${rate} calls a minute from the whole app`}. Fix: ${fix('proxy', { upstreams: { [name]: { rules: { call: 'user' } } } })}${cap}.`,
      });
    } else if (!authOn && needsSignIn(call)) {
      out.push({
        code: 'rule_needs_auth_module',
        message: `Upstream "${name}" may be called only by signed-in users (rules.call: "${call}"), ${NO_AUTH} and every call answers 401. Fix: ${ENABLE_AUTH}.`,
      });
    }
  }
  return out;
}

function pendingFindings(m: ReadinessModule): CheckFinding[] {
  return (m.pending ?? []).map((change) => ({
    code: 'module_change_pending',
    message: `A ${m.name} change waits for the owner's confirmation and is not live yet: ${change}. Until it is confirmed the app runs with the current config — give the user the confirm_url from get_app (modules.${m.name}).`,
  }));
}

/**
 * The module rules audit over the app's live module configs:
 * collections anyone may write without a (bounded) schema, public reads of
 * personal fields, rules that need a sign-in on an app without the auth
 * module and upstreams anonymous visitors may call — plus every change still
 * waiting for the owner's confirmation. The forms module has no per-form
 * limit or captcha setting (its honeypot, time token and per-IP / per-app
 * limits always apply), so a public form alone is not reported.
 */
export const moduleRules: ReadinessCheck = {
  id: 'module-rules',
  codes: [
    'data_public_write_no_schema',
    'data_public_write_unbounded',
    'data_public_read_personal',
    'rule_needs_auth_module',
    'proxy_public_upstream',
    'module_change_pending',
  ],
  needsModules: true,
  run({ modules }) {
    const on = modules.filter((m) => m.enabled);
    const authOn = on.some((m) => m.name === 'auth');
    const out: CheckFinding[] = [];
    for (const m of on) {
      const config = isObj(m.config) ? m.config : {};
      if (m.name === 'data') out.push(...dataFindings(config, authOn));
      else if (m.name === 'forms') out.push(...formsFindings(config, authOn));
      else if (m.name === 'proxy') out.push(...proxyFindings(config, authOn));
    }
    for (const m of on) out.push(...pendingFindings(m));
    return out;
  },
};
