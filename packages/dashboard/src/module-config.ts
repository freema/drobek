/**
 * The Modules tab's pure logic (M2-02, NSO-291) — client-safe, no server
 * imports, unit-tested in module-config.test.ts:
 *
 *  - `schemaFields` — a module's config JSON Schema (zod → JSON Schema) →
 *    the form fields of our own small renderer. The subset the modules use:
 *    objects with properties (nested), string, string enum, number, integer,
 *    boolean, arrays of strings; anything else (a record of named entries,
 *    arrays of objects, unions) is edited as a JSON field. No vendor form
 *    library.
 *  - `formToConfig` — the submitted form → a config value. The SERVER then
 *    validates it through the module's real configSchema (the configure path
 *    configure_module uses), so the form never decides what is valid.
 *  - `mergePatchBetween` — before/after → the RFC 7396 merge patch the
 *    configure path takes (keys that disappear become `null`).
 *  - `configDiff` — the readable before → after list of a pending change.
 *  - `fieldErrors` — configure's issue paths (`allow.emails[0]`) → the field
 *    they belong to.
 *  - rule ⇄ principal checkboxes, the plain-language risk note of a
 *    confirmRequired string.
 */

export type FieldKind = 'object' | 'string' | 'enum' | 'number' | 'integer' | 'boolean' | 'string-list' | 'json';

export interface FormField {
  /** Dotted config path, e.g. `allow.emails`. */
  path: string;
  /** The last path segment. */
  key: string;
  label: string;
  description?: string;
  kind: FieldKind;
  required: boolean;
  /** `enum` fields: the choices. */
  options?: string[];
  /** `object` fields: the nested fields. */
  children?: FormField[];
  min?: number;
  max?: number;
  maxLength?: number;
}

/** Form input names are the config path under this prefix. */
export const FIELD_PREFIX = 'cfg.';

export function fieldName(path: string): string {
  return `${FIELD_PREFIX}${path}`;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function humanize(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function typeOf(node: Json): string | undefined {
  const t = node.type;
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.find((x) => x !== 'null') as string | undefined;
  return undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function fieldOf(key: string, path: string, node: unknown, required: boolean): FormField {
  const n = isObject(node) ? node : {};
  const base = {
    path,
    key,
    label: typeof n.title === 'string' && n.title ? n.title : humanize(key),
    ...(typeof n.description === 'string' && n.description ? { description: n.description } : {}),
    required,
  };
  const t = typeOf(n);
  if (Array.isArray(n.enum) && n.enum.length > 0 && n.enum.every((x) => typeof x === 'string')) {
    return { ...base, kind: 'enum', options: n.enum as string[] };
  }
  if (t === 'string') {
    const maxLength = num(n.maxLength);
    return { ...base, kind: 'string', ...(maxLength !== undefined ? { maxLength } : {}) };
  }
  if (t === 'number' || t === 'integer') {
    const min = num(n.minimum);
    const max = num(n.maximum);
    return { ...base, kind: t, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
  }
  if (t === 'boolean') return { ...base, kind: 'boolean' };
  if (t === 'array' && isObject(n.items) && typeOf(n.items) === 'string' && !Array.isArray(n.items.enum)) {
    return { ...base, kind: 'string-list' };
  }
  if (t === 'object' && isObject(n.properties) && Object.keys(n.properties).length > 0) {
    return { ...base, kind: 'object', children: objectFields(n, path) };
  }
  return { ...base, kind: 'json' };
}

function objectFields(node: Json, prefix: string, skip: ReadonlySet<string> = new Set()): FormField[] {
  const props = isObject(node.properties) ? node.properties : {};
  const required = new Set(Array.isArray(node.required) ? node.required.map(String) : []);
  return Object.entries(props)
    .filter(([key]) => !skip.has(key))
    .map(([key, child]) => fieldOf(key, prefix ? `${prefix}.${key}` : key, child, required.has(key)));
}

/**
 * The form fields of a config JSON Schema (its top-level object). `skip`
 * leaves out top-level keys a dedicated editor handles (the data module's
 * `collections`, the proxy module's `upstreams`). A schema that is not an
 * object with properties → no fields.
 */
export function schemaFields(schema: unknown, skip: readonly string[] = []): FormField[] {
  if (!isObject(schema)) return [];
  return objectFields(schema, '', new Set(skip));
}

/** Every leaf field (objects flattened), in order. */
export function leafFields(fields: readonly FormField[]): FormField[] {
  return fields.flatMap((f) => (f.kind === 'object' ? leafFields(f.children ?? []) : [f]));
}

export function valueAt(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (!isObject(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** What a field's input shows: text for text-like fields, a flag for checkboxes. */
export type FieldValue = string | boolean;

/** The input values of `fields` for a config (string lists one per line, JSON pretty-printed). */
export function fieldValues(fields: readonly FormField[], config: unknown): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const f of leafFields(fields)) {
    const v = valueAt(config, f.path);
    switch (f.kind) {
      case 'boolean':
        out[f.path] = v === true;
        break;
      case 'string-list':
        out[f.path] = Array.isArray(v) ? v.map(String).join('\n') : '';
        break;
      case 'json':
        out[f.path] = v === undefined ? '' : JSON.stringify(v, null, 2);
        break;
      default:
        out[f.path] = v === undefined || v === null ? '' : String(v);
    }
  }
  return out;
}

/** Read access to a submitted form (FormData-shaped, so tests can pass a Map). */
export interface FormReader {
  get(name: string): unknown;
  has(name: string): boolean;
}

export interface FormToConfigResult {
  /** The config the form describes (keys of empty optional fields left out). */
  value: Json;
  /** The raw submitted input values (re-shown next to the errors). */
  values: Record<string, FieldValue>;
  /** Errors found before validation (a number that is not one, broken JSON). */
  errors: Record<string, string>;
}

/**
 * The submitted form → a config value. Only obvious input errors are caught
 * here; everything else is the module's configSchema's call on the server.
 */
export function formToConfig(fields: readonly FormField[], form: FormReader): FormToConfigResult {
  const values: Record<string, FieldValue> = {};
  const errors: Record<string, string> = {};

  const read = (list: readonly FormField[]): Json => {
    const out: Json = {};
    for (const f of list) {
      if (f.kind === 'object') {
        out[f.key] = read(f.children ?? []);
        continue;
      }
      const name = fieldName(f.path);
      if (f.kind === 'boolean') {
        const on = form.has(name) && form.get(name) !== 'false';
        values[f.path] = on;
        out[f.key] = on;
        continue;
      }
      const raw = form.get(name);
      const text = typeof raw === 'string' ? raw : '';
      values[f.path] = text;
      switch (f.kind) {
        case 'string':
        case 'enum':
          if (text === '' && !f.required) break;
          out[f.key] = text;
          break;
        case 'number':
        case 'integer': {
          if (text.trim() === '') break;
          const n = Number(text.trim());
          if (!Number.isFinite(n) || (f.kind === 'integer' && !Number.isInteger(n))) {
            errors[f.path] = f.kind === 'integer' ? 'Enter a whole number.' : 'Enter a number.';
            break;
          }
          out[f.key] = n;
          break;
        }
        case 'string-list':
          out[f.key] = text
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          break;
        case 'json':
          if (text.trim() === '') break;
          try {
            out[f.key] = JSON.parse(text);
          } catch (err) {
            errors[f.path] = `Not valid JSON: ${(err as Error).message}`;
          }
          break;
      }
    }
    return out;
  };

  return { value: read(fields), values, errors };
}

/** The JSON value equality of two config values (key order ignored). */
export function jsonEqualValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => jsonEqualValue(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqualValue(a[k], b[k]));
  }
  return false;
}

/**
 * The RFC 7396 merge patch that turns `before` into `after` (undefined when
 * they are equal): changed keys carry the new value, removed keys `null`,
 * objects recurse, arrays and scalars are replaced whole.
 */
export function mergePatchBetween(before: unknown, after: unknown): unknown {
  if (isObject(before) && isObject(after)) {
    const out: Json = {};
    for (const k of Object.keys(before)) if (!Object.prototype.hasOwnProperty.call(after, k)) out[k] = null;
    for (const [k, v] of Object.entries(after)) {
      if (v === undefined) {
        if (Object.prototype.hasOwnProperty.call(before, k) && before[k] !== undefined) out[k] = null;
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(before, k)) {
        out[k] = v;
        continue;
      }
      const d = mergePatchBetween(before[k], v);
      if (d !== undefined) out[k] = d;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return jsonEqualValue(before, after) ? undefined : after;
}

export interface DiffEntry {
  path: string;
  before: string;
  after: string;
}

function flatten(v: unknown, prefix: string, out: Map<string, unknown>): void {
  if (isObject(v) && Object.keys(v).length > 0) {
    for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, out);
    return;
  }
  out.set(prefix || '(root)', v);
}

/** How a config value reads in the diff. */
export function showValue(v: unknown): string {
  if (v === undefined) return '(not set)';
  if (isObject(v) && Object.keys(v).length === 0) return '{}';
  return JSON.stringify(v);
}

/** Every leaf path that differs between two effective configs (sorted). */
export function configDiff(before: unknown, after: unknown): DiffEntry[] {
  const a = new Map<string, unknown>();
  const b = new Map<string, unknown>();
  flatten(before, '', a);
  flatten(after, '', b);
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  const out: DiffEntry[] = [];
  for (const p of paths) {
    const x = a.get(p);
    const y = b.get(p);
    if (jsonEqualValue(x, y)) continue;
    // A parent that was empty before and has children now shows only the children.
    if ((isObject(x) && Object.keys(x).length === 0 && y === undefined) || (isObject(y) && Object.keys(y).length === 0 && x === undefined)) {
      continue;
    }
    out.push({ path: p, before: showValue(x), after: showValue(y) });
  }
  return out;
}

export interface Issue {
  path: string;
  message: string;
}

/** An issue path (`a.b[0].c`) as dotted segments without indexes (`a.b.c`)… */
function normalizeIssuePath(path: string): string {
  return path.replace(/\[[^\]]*\]/g, '');
}

/**
 * configure's issues → the field each belongs to: the longest field path
 * that is the issue's path or a parent of it (`allow.emails[0]` →
 * `allow.emails`); the rest (the root, a key no field shows) → `general`.
 */
export function fieldErrors(issues: readonly Issue[], fieldPaths: readonly string[]): { fields: Record<string, string[]>; general: string[] } {
  const fields: Record<string, string[]> = {};
  const general: string[] = [];
  const sorted = [...fieldPaths].sort((x, y) => y.length - x.length);
  for (const issue of issues) {
    const p = normalizeIssuePath(issue.path);
    const hit = sorted.find((f) => p === f || p.startsWith(`${f}.`));
    if (hit) {
      const where = issue.path === hit ? '' : `${issue.path.slice(hit.length).replace(/^\./, '')}: `;
      (fields[hit] ??= []).push(`${where}${issue.message}`);
    } else {
      general.push(issue.path === '(root)' ? issue.message : `${issue.path}: ${issue.message}`);
    }
  }
  return { fields, general };
}

// ── rules ────────────────────────────────────────────────────────────────────

/** The principals of a rule, in the editor's column order. */
export const PRINCIPALS = ['public', 'user', 'owner', 'admin'] as const;
export type PrincipalName = (typeof PRINCIPALS)[number];

export const PRINCIPAL_LABEL: Record<PrincipalName, string> = {
  public: 'Anyone',
  user: 'Signed-in users',
  owner: 'Record owner',
  admin: 'App admins',
};

/** `"owner|admin"` → ['owner', 'admin']; `none` / empty → []. */
export function ruleToPrincipals(rule: string | undefined): PrincipalName[] {
  const tokens = new Set(
    String(rule ?? '')
      .split('|')
      .map((t) => t.trim())
      .filter(Boolean)
  );
  return PRINCIPALS.filter((p) => tokens.has(p));
}

/** Checked principals → a canonical rule (`none` when nothing is checked). */
export function principalsToRule(principals: readonly string[]): string {
  const set = new Set(principals);
  const picked = PRINCIPALS.filter((p) => set.has(p));
  return picked.length === 0 ? 'none' : picked.join('|');
}

/** The input name of one rule checkbox. */
export function ruleInputName(op: string, principal: string): string {
  return `rule.${op}.${principal}`;
}

/** The rule of `op` from submitted checkboxes. */
export function ruleFromForm(form: FormReader, op: string, principals: readonly string[] = PRINCIPALS): string {
  return principalsToRule(principals.filter((p) => form.has(ruleInputName(op, p))));
}

// ── risk notes ───────────────────────────────────────────────────────────────

/**
 * A plain-language note on what confirming a confirmRequired string means for
 * the owner (the string itself is the module's own, verbatim).
 */
export function riskNote(change: string): string {
  const c = change.toLowerCase();
  if (/\bpublic\b/.test(c)) {
    return 'Makes this open to anyone on the internet — signed in or not. Confirm only if the app is meant to be public.';
  }
  if (c.includes('anyone')) {
    return 'Anyone with an e-mail address could sign in or act without being invited. Confirm only if the app is meant to be open.';
  }
  if (c.includes('upstream') || c.includes('secret')) {
    return 'The app starts calling an external service with your workspace credentials. Confirm only if the app should use it.';
  }
  if (c.includes('@') || c.includes('email') || c.includes('replyto')) {
    return 'E-mail from this app will go to (or reply to) this address. Confirm only if you know and trust it.';
  }
  if (c.includes('removed')) {
    return 'Stored records are no longer checked against a schema: any shape can be saved afterwards.';
  }
  if (c.includes('signed-in user') || c.includes('every record')) {
    return 'Every signed-in user could change or delete records of other users.';
  }
  return 'This widens what the app can do, so it waits for your approval.';
}
