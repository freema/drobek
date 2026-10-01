/**
 * The Modules tab's pure logic — client-safe, no server
 * imports, unit-tested in module-config.test.ts:
 *
 *  - `schemaFields` — a module's config JSON Schema (zod → JSON Schema) →
 *    the form fields of our own small renderer: objects with properties
 *    (nested), string, string enum, number / integer (min / max), boolean,
 *    arrays of strings, arrays of string enums (checkboxes), records of named
 *    entries (`additionalProperties`) and arrays of objects — entries added /
 *    removed, each rendered recursively, up to MAX_ENTRY_DEPTH levels of
 *    entries; anything else (unions, a record of anything, deeper nesting) is
 *    edited as a JSON field. `description` (zod `.describe()`) is shown under
 *    the field; a string field annotated `x-drobek-choices` becomes a select
 *    whose choices the loader resolves (module-choices.server.ts); a
 *    record's `propertyNames` title / description label its entries' names
 *    (its `x-drobek-choices` suggest a new entry's name). `x-drobek-rule`
 *    makes a rule string principal checkboxes, `x-drobek-unit: 'bytes'` a
 *    number entered in MB, `x-drobek-hidden` a value carried through a save
 *    unseen, `x-drobek-order` puts an object's listed keys first.
 *    No vendor form library, no client JS: a new entry is the one
 *    empty entry each record / list renders, a removal a checkbox.
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
import type { ConfigChoices, ConfigFieldMeta, ConfigUnit } from '@drobek/modules';

type FieldKind =
  | 'object'
  | 'string'
  | 'enum'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'string-list'
  | 'enum-list'
  | 'record'
  | 'object-list'
  | 'rule'
  | 'json';

export interface FormField {
  /** Dotted config path, e.g. `allow.emails` — relative to the entry inside a `record` / `object-list` entry. */
  path: string;
  /** The last path segment. */
  key: string;
  label: string;
  description?: string;
  kind: FieldKind;
  required: boolean;
  /** `enum` / `enum-list` fields: the choices. */
  options?: string[];
  /** `object` fields: the nested fields. */
  children?: FormField[];
  /**
   * `record` / `object-list` fields: the fields of ONE entry, their paths
   * relative to the entry. A record of plain values has one field, `$value`.
   */
  entry?: FormField[];
  /** The schema's `default` of a leaf (what a new entry's input starts with). */
  default?: unknown;
  min?: number;
  max?: number;
  maxLength?: number;
  /** List fields (`string-list`, `enum-list`, `object-list`): how many items the schema asks for. */
  minItems?: number;
  maxItems?: number;
  /** `string` fields annotated `x-drobek-choices`: where the select's choices come from. */
  choices?: ConfigChoices;
  /** With `choices: 'intervals'`: the module limit holding the shortest interval in minutes (`x-drobek-min-interval`). */
  minInterval?: string;
  /**
   * `record` fields: the label and hint of an entry's name (the record's
   * `propertyNames` title / description) and where suggestions for a new
   * entry's name come from (its `x-drobek-choices`).
   */
  entryKey?: { label: string; description?: string } & Pick<FormField, 'choices' | 'minInterval'>;
  /** `rule` fields: the principals the checkboxes offer (`x-drobek-rule`). */
  principals?: PrincipalName[];
  /** `number` / `integer` fields: the unit the value is stored in (`x-drobek-unit`); `bytes` is entered in MB. */
  unit?: ConfigUnit;
  /** The module limit whose workspace value applies while the field is empty (`x-drobek-default-limit`). */
  defaultLimit?: string;
  /** `x-drobek-hidden`: not shown; a hidden input carries the current value (as JSON) through a save. */
  hidden?: true;
}

/** Form input names are the config path under this prefix. */
const FIELD_PREFIX = 'cfg.';

/**
 * How deep `record` / `object-list` fields nest (a record of lists of
 * records…); a deeper one is a JSON field.
 */
export const MAX_ENTRY_DEPTH = 3;
/** The most entries one `record` / `object-list` input reads (a forged count cannot loop forever). */
const MAX_ENTRIES = 1000;

/** The pseudo-path of a record entry's plain value (a record of strings, numbers…). */
export const ENTRY_VALUE = '$value';

export function fieldName(path: string): string {
  return `${FIELD_PREFIX}${path}`;
}

/**
 * The input names of a `record` / `object-list` field whose inputs live at
 * `instance` (its path, or `<collection>[<i>].<path>` inside an entry): the
 * number of entries rendered, and per entry its prefix, name (records),
 * remove box and the marker of the empty "add" entry.
 */
export const entryInputs = {
  count: (instance: string) => fieldName(`${instance}.$count`),
  prefix: (instance: string, i: number) => `${instance}[${i}]`,
  key: (instance: string, i: number) => fieldName(`${instance}[${i}].$key`),
  remove: (instance: string, i: number) => fieldName(`${instance}[${i}].$remove`),
  isNew: (instance: string, i: number) => fieldName(`${instance}[${i}].$new`),
} as const;

/** The input name of one `enum-list` checkbox (by option index — option values may hold any character). */
export function optionInputName(instance: string, index: number): string {
  return fieldName(`${instance}[${index}]`);
}

/** Where a field's inputs live: its path under the entry prefix (`''` at the top level). */
export function instancePath(prefix: string, path: string): string {
  return prefix ? `${prefix}.${path}` : path;
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

/** A numeric bound worth showing (zod's integer bounds are ±MAX_SAFE_INTEGER — no real limit). */
function bound(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined && Math.abs(n) < Number.MAX_SAFE_INTEGER ? n : undefined;
}

function itemBounds(n: Json): { minItems?: number; maxItems?: number } {
  const minItems = bound(n.minItems);
  const maxItems = bound(n.maxItems);
  return { ...(minItems !== undefined ? { minItems } : {}), ...(maxItems !== undefined ? { maxItems } : {}) };
}

const CHOICES_KEY: keyof ConfigFieldMeta = 'x-drobek-choices';
const MIN_INTERVAL_KEY: keyof ConfigFieldMeta = 'x-drobek-min-interval';
const RULE_KEY: keyof ConfigFieldMeta = 'x-drobek-rule';
const UNIT_KEY: keyof ConfigFieldMeta = 'x-drobek-unit';
const DEFAULT_LIMIT_KEY: keyof ConfigFieldMeta = 'x-drobek-default-limit';
const HIDDEN_KEY: keyof ConfigFieldMeta = 'x-drobek-hidden';
const ORDER_KEY: keyof ConfigFieldMeta = 'x-drobek-order';
const CHOICE_SOURCES: ReadonlySet<string> = new Set<ConfigChoices>(['upstreams', 'collections', 'intervals', 'forms']);
const UNITS: ReadonlySet<string> = new Set<ConfigUnit>(['bytes']);

/** A string node's `x-drobek-choices` (+ `x-drobek-min-interval`) as FormField properties; an unknown source is ignored. */
function choicesOf(n: Json): Pick<FormField, 'choices' | 'minInterval'> {
  const from = n[CHOICES_KEY];
  if (typeof from !== 'string' || !CHOICE_SOURCES.has(from)) return {};
  const min = n[MIN_INTERVAL_KEY];
  return { choices: from as ConfigChoices, ...(from === 'intervals' && typeof min === 'string' && min ? { minInterval: min } : {}) };
}

/** A record's `entryKey` from its `propertyNames` title / description / choices (none without any: the name is labelled "Name"). */
function entryKeyOf(n: Json): Pick<FormField, 'entryKey'> {
  const names = isObject(n.propertyNames) ? n.propertyNames : {};
  const title = typeof names.title === 'string' && names.title ? names.title : null;
  const description = typeof names.description === 'string' && names.description ? names.description : null;
  const choices = choicesOf(names);
  if (!title && !description && !choices.choices) return {};
  return { entryKey: { label: title ?? 'Name', ...(description ? { description } : {}), ...choices } };
}

/** The principals an `x-drobek-rule` node offers (`true`: all of them); null when it is no rule field. */
function rulePrincipalsOf(n: Json): PrincipalName[] | null {
  const v = n[RULE_KEY];
  if (v === true) return [...PRINCIPALS];
  if (!Array.isArray(v)) return null;
  const listed = new Set(v);
  const offered = PRINCIPALS.filter((p) => listed.has(p));
  return offered.length > 0 ? offered : null;
}

/** A number node's `x-drobek-unit` (an unknown unit is ignored). */
function unitOf(n: Json): Pick<FormField, 'unit'> {
  const unit = n[UNIT_KEY];
  return typeof unit === 'string' && UNITS.has(unit) ? { unit: unit as ConfigUnit } : {};
}

/** An object's properties: the keys its `x-drobek-order` lists first (in that order), then the rest in schema order. */
function orderedProperties(node: Json): [string, unknown][] {
  const props = isObject(node.properties) ? node.properties : {};
  const order = node[ORDER_KEY];
  const listed = Array.isArray(order) ? order.filter((k): k is string => typeof k === 'string' && Object.prototype.hasOwnProperty.call(props, k)) : [];
  const first = [...new Set(listed)];
  const rest = Object.keys(props).filter((k) => !first.includes(k));
  return [...first, ...rest].map((k) => [k, props[k]]);
}

function stringEnum(node: unknown): string[] | null {
  if (!isObject(node) || !Array.isArray(node.enum) || node.enum.length === 0) return null;
  return node.enum.every((x) => typeof x === 'string') ? (node.enum as string[]) : null;
}

/**
 * A nullable / optional wrapper zod renders as `anyOf: [<schema>, { type:
 * 'null' }]` → the one real branch (its description / default kept from the
 * wrapper). Anything else is returned as is.
 */
function unwrapNullable(n: Json): Json {
  if (!Array.isArray(n.anyOf) || typeOf(n) !== undefined) return n;
  const real = n.anyOf.filter((b) => !(isObject(b) && b.type === 'null'));
  if (real.length !== 1 || !isObject(real[0])) return n;
  const rest: Json = { ...n };
  delete rest.anyOf;
  return { ...real[0], ...rest };
}

function fieldOf(key: string, path: string, node: unknown, required: boolean, depth: number): FormField {
  const n = unwrapNullable(isObject(node) ? node : {});
  const base = {
    path,
    key,
    label: typeof n.title === 'string' && n.title ? n.title : key === ENTRY_VALUE ? 'Value' : humanize(key),
    ...(typeof n.description === 'string' && n.description ? { description: n.description } : {}),
    required,
    ...(n.default !== undefined ? { default: n.default } : {}),
    ...(typeof n[DEFAULT_LIMIT_KEY] === 'string' && n[DEFAULT_LIMIT_KEY] ? { defaultLimit: n[DEFAULT_LIMIT_KEY] } : {}),
  };
  // A hidden value round-trips as JSON, whatever its type.
  if (n[HIDDEN_KEY] === true) return { ...base, kind: 'json', hidden: true };
  const t = typeOf(n);
  const choices = stringEnum(n);
  if (choices) return { ...base, kind: 'enum', options: choices };
  if (t === 'string') {
    const maxLength = num(n.maxLength);
    const principals = rulePrincipalsOf(n);
    if (principals) return { ...base, kind: 'rule', principals };
    return { ...base, kind: 'string', ...(maxLength !== undefined ? { maxLength } : {}), ...choicesOf(n) };
  }
  if (t === 'number' || t === 'integer') {
    const min = bound(n.minimum);
    const max = bound(n.maximum);
    return { ...base, kind: t, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...unitOf(n) };
  }
  if (t === 'boolean') return { ...base, kind: 'boolean' };
  if (t === 'array' && isObject(n.items)) {
    const items = unwrapNullable(n.items);
    const itemChoices = stringEnum(items);
    if (itemChoices) return { ...base, kind: 'enum-list', options: itemChoices, ...itemBounds(n) };
    if (typeOf(items) === 'string') return { ...base, kind: 'string-list', ...itemBounds(n) };
    // An array of objects: each item is an entry (add / remove, fields recursively).
    if (depth < MAX_ENTRY_DEPTH && typeOf(items) === 'object' && isObject(items.properties) && Object.keys(items.properties).length > 0) {
      return { ...base, kind: 'object-list', entry: objectFields(items, '', depth + 1), ...itemBounds(n) };
    }
  }
  if (t === 'object' && isObject(n.properties) && Object.keys(n.properties).length > 0) {
    return { ...base, kind: 'object', children: objectFields(n, path, depth) };
  }
  // A record (`additionalProperties` schema, no fixed properties): named entries.
  if (t === 'object' && depth < MAX_ENTRY_DEPTH && isObject(n.additionalProperties) && !isObject(n.properties)) {
    const value = unwrapNullable(n.additionalProperties);
    if (typeOf(value) === 'object' && isObject(value.properties) && Object.keys(value.properties).length > 0) {
      return { ...base, kind: 'record', entry: objectFields(value, '', depth + 1), ...entryKeyOf(n) };
    }
    const plain = fieldOf(ENTRY_VALUE, ENTRY_VALUE, value, true, depth + 1);
    // A record of anything / of unrepresentable values stays one JSON field; at
    // the deepest level a structured value is edited as JSON inside its entry.
    const structured = typeOf(value) === 'object' || typeOf(value) === 'array';
    if (plain.kind !== 'json' || (structured && depth + 1 >= MAX_ENTRY_DEPTH)) return { ...base, kind: 'record', entry: [plain], ...entryKeyOf(n) };
  }
  return { ...base, kind: 'json' };
}

function objectFields(node: Json, prefix: string, depth: number, skip: ReadonlySet<string> = new Set()): FormField[] {
  const required = new Set(Array.isArray(node.required) ? node.required.map(String) : []);
  return orderedProperties(node)
    .filter(([key]) => !skip.has(key))
    .map(([key, child]) => fieldOf(key, prefix ? `${prefix}.${key}` : key, child, required.has(key), depth));
}

/**
 * The form fields of a config JSON Schema (its top-level object). `skip`
 * leaves out top-level keys a dedicated editor handles (the `collections` /
 * `upstreams` key of a module declaring `dashboard.editor`). A schema that
 * is not an object with properties → no fields.
 */
export function schemaFields(schema: unknown, skip: readonly string[] = []): FormField[] {
  if (!isObject(schema)) return [];
  return objectFields(schema, '', 0, new Set(skip));
}

/** The key a field's resolved choices are kept under (one list per source; intervals per minimum). */
export function choiceKey(f: Pick<FormField, 'choices' | 'minInterval'>): string | null {
  if (!f.choices) return null;
  return f.choices === 'intervals' ? `intervals:${f.minInterval ?? ''}` : f.choices;
}

/** One list of choices the form needs: its key, its source and, for intervals, the limit holding the minimum. */
export interface ChoiceRequest {
  key: string;
  from: ConfigChoices;
  minInterval?: string;
}

/** The choice lists `fields` need (objects, record / list entries and entry names included), each once. */
export function choiceRequests(fields: readonly FormField[]): ChoiceRequest[] {
  const out = new Map<string, ChoiceRequest>();
  const add = (c: Pick<FormField, 'choices' | 'minInterval'>) => {
    const key = choiceKey(c);
    if (key && c.choices && !out.has(key)) out.set(key, { key, from: c.choices, ...(c.minInterval ? { minInterval: c.minInterval } : {}) });
  };
  const walk = (list: readonly FormField[]) => {
    for (const f of list) {
      add(f);
      if (f.entryKey) add(f.entryKey);
      walk(f.children ?? []);
      walk(f.entry ?? []);
    }
  };
  walk(fields);
  return [...out.values()];
}

/** The module limits `fields` name as what an empty field means (`x-drobek-default-limit`), each once. */
export function defaultLimitNames(fields: readonly FormField[]): string[] {
  const out = new Set<string>();
  const walk = (list: readonly FormField[]) => {
    for (const f of list) {
      if (f.defaultLimit) out.add(f.defaultLimit);
      walk(f.children ?? []);
      walk(f.entry ?? []);
    }
  };
  walk(fields);
  return [...out];
}

/** Bytes in one MB, the unit a `bytes` field is entered in. */
export const BYTES_PER_MB = 1024 * 1024;

/**
 * Bytes as the MB an input shows. Exact: a whole number of bytes over 2^20 is
 * a finite binary fraction, and `String` gives the shortest text that parses
 * back to it — so an untouched value saves the same bytes.
 */
function bytesToMb(bytes: number): string {
  return String(bytes / BYTES_PER_MB);
}

/** A size for a hint, in MB with at most two decimals ("25 MB", "4.77 MB"). */
export function mbLabel(bytes: number): string {
  return `${Number((bytes / BYTES_PER_MB).toFixed(2))} MB`;
}

/**
 * The input names of a `rule` field at `instance`: one checkbox per
 * principal, and the rule the form showed — kept as written when the same
 * principals come back, so an untouched rule saves unchanged.
 */
export const ruleInputs = {
  principal: (instance: string, principal: PrincipalName) => fieldName(`${instance}.$${principal}`),
  shown: (instance: string) => fieldName(`${instance}.$shown`),
} as const;

/** Every leaf field (objects flattened; a `record` / `object-list` is one leaf), in order. */
export function leafFields(fields: readonly FormField[]): FormField[] {
  return fields.flatMap((f) => (f.kind === 'object' ? leafFields(f.children ?? []) : [f]));
}

function valueAt(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (!isObject(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** One entry of a `record` / `object-list` field as its inputs show it. */
interface EntryValue {
  /** The record entry's name (absent for list items). */
  key?: string;
  /** The entry's input values by their path relative to the entry. */
  values: Record<string, FieldValue>;
}

/** What a `record` / `object-list` field's inputs show: its entries in order. */
export interface EntriesValue {
  entries: EntryValue[];
}

/**
 * What a field's input shows: text for text-like fields, a flag for
 * checkboxes, the checked options of an `enum-list`, the entries of a
 * `record` / `object-list`.
 */
export type FieldValue = string | boolean | string[] | EntriesValue;

export function isEntriesValue(v: FieldValue | undefined): v is EntriesValue {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Array.isArray((v as EntriesValue).entries);
}

function entryValues(f: FormField, value: unknown): Record<string, FieldValue> {
  const entry = f.entry ?? [];
  const plain = entry.length === 1 && entry[0].path === ENTRY_VALUE;
  return fieldValues(entry, plain ? { [ENTRY_VALUE]: value } : value);
}

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
      case 'enum-list':
        out[f.path] = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
        break;
      case 'record':
        out[f.path] = { entries: isObject(v) ? Object.entries(v).map(([key, x]) => ({ key, values: entryValues(f, x) })) : [] };
        break;
      case 'object-list':
        out[f.path] = { entries: Array.isArray(v) ? v.map((x) => ({ values: entryValues(f, x) })) : [] };
        break;
      case 'json':
        out[f.path] = v === undefined ? '' : f.hidden ? JSON.stringify(v) : JSON.stringify(v, null, 2);
        break;
      case 'number':
      case 'integer':
        out[f.path] = typeof v === 'number' && f.unit === 'bytes' ? bytesToMb(v) : v === undefined || v === null ? '' : String(v);
        break;
      default:
        out[f.path] = v === undefined || v === null ? '' : String(v);
    }
  }
  return out;
}

/** The input values of a new, empty entry of a `record` / `object-list` field (the schema defaults). */
export function blankEntryValues(f: FormField): Record<string, FieldValue> {
  const config: Json = {};
  const put = (path: string, value: unknown) => {
    const segs = path.split('.');
    let cur = config;
    for (const s of segs.slice(0, -1)) cur = (cur[s] = isObject(cur[s]) ? cur[s] : {}) as Json;
    cur[segs[segs.length - 1]] = value;
  };
  for (const leaf of leafFields(f.entry ?? [])) if (leaf.default !== undefined) put(leaf.path, leaf.default);
  return fieldValues(f.entry ?? [], config);
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
  /** Errors found before validation (a number that is not one, broken JSON), by top-level field path. */
  errors: Record<string, string>;
}

interface ReadScope {
  /** The input name prefix of this level (`''` top level, `<collection>[<i>]` inside an entry). */
  prefix: string;
  /** Where the values of this level go. */
  values: Record<string, FieldValue>;
  /** Inside an entry: the top-level field that shows every error below it, and where in it we are. */
  owner?: { path: string; where: string };
}

/**
 * The submitted form → a config value. Only obvious input errors are caught
 * here; everything else is the module's configSchema's call on the server.
 */
export function formToConfig(fields: readonly FormField[], form: FormReader): FormToConfigResult {
  const values: Record<string, FieldValue> = {};
  const errors: Record<string, string> = {};

  const fail = (scope: ReadScope, f: FormField, message: string) => {
    if (!scope.owner) {
      errors[f.path] ??= message;
      return;
    }
    const where = [scope.owner.where, f.path === ENTRY_VALUE ? '' : f.path].filter(Boolean).join(' › ');
    errors[scope.owner.path] ??= `${where}: ${message}`;
  };

  const readEntries = (f: FormField, scope: ReadScope): { value: unknown; shown: EntriesValue } => {
    const instance = instancePath(scope.prefix, f.path);
    const record = f.kind === 'record';
    const entryFields = f.entry ?? [];
    const plain = entryFields.length === 1 && entryFields[0].path === ENTRY_VALUE;
    const count = Math.min(MAX_ENTRIES, Math.max(0, Number.parseInt(String(form.get(entryInputs.count(instance)) ?? '0'), 10) || 0));
    const blank = blankEntryValues(f);
    const shown: EntryValue[] = [];
    const out: Json = {};
    const list: unknown[] = [];
    for (let i = 0; i < count; i++) {
      if (form.has(entryInputs.remove(instance, i))) continue;
      const isNew = form.has(entryInputs.isNew(instance, i));
      const rawKey = record ? form.get(entryInputs.key(instance, i)) : undefined;
      const key = typeof rawKey === 'string' ? rawKey.trim() : '';
      const label = record ? (key ? `"${key}"` : 'new entry') : `item ${i + 1}`;
      const entryScope: ReadScope = {
        prefix: entryInputs.prefix(instance, i),
        values: {},
        owner: { path: scope.owner?.path ?? f.path, where: [scope.owner?.where, scope.owner && f.path !== ENTRY_VALUE ? f.path : '', label].filter(Boolean).join(' › ') },
      };
      const value = readFields(entryFields, entryScope);
      // An untouched "add" entry is not an entry.
      if (isNew && key === '' && jsonEqualValue(entryScope.values, blank)) continue;
      shown.push(record ? { key, values: entryScope.values } : { values: entryScope.values });
      const entryValue = plain ? value[ENTRY_VALUE] : value;
      if (!record) {
        list.push(entryValue);
        continue;
      }
      if (key === '') {
        fail(scope, f, 'Name the new entry.');
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        fail(scope, f, `Two entries are named "${key}".`);
        continue;
      }
      out[key] = entryValue;
    }
    return { value: record ? out : list, shown: { entries: shown } };
  };

  const readFields = (list: readonly FormField[], scope: ReadScope): Json => {
    const out: Json = {};
    for (const f of list) {
      if (f.kind === 'object') {
        out[f.key] = readFields(f.children ?? [], scope);
        continue;
      }
      const instance = instancePath(scope.prefix, f.path);
      const name = fieldName(instance);
      if (f.kind === 'boolean') {
        const on = form.has(name) && form.get(name) !== 'false';
        scope.values[f.path] = on;
        out[f.key] = on;
        continue;
      }
      if (f.kind === 'enum-list') {
        const picked = (f.options ?? []).filter((_, j) => form.has(optionInputName(instance, j)));
        scope.values[f.path] = picked;
        out[f.key] = picked;
        continue;
      }
      if (f.kind === 'record' || f.kind === 'object-list') {
        const r = readEntries(f, scope);
        scope.values[f.path] = r.shown;
        out[f.key] = r.value;
        continue;
      }
      if (f.kind === 'rule') {
        const picked = PRINCIPALS.filter((p) => form.has(ruleInputs.principal(instance, p)));
        const shown = form.get(ruleInputs.shown(instance));
        const same = typeof shown === 'string' && samePrincipals(ruleToPrincipals(shown), picked);
        const rule = same ? shown : principalsToRule(picked);
        scope.values[f.path] = rule;
        if (rule !== '') out[f.key] = rule;
        continue;
      }
      const raw = form.get(name);
      const text = typeof raw === 'string' ? raw : '';
      scope.values[f.path] = text;
      switch (f.kind) {
        case 'string':
        case 'enum':
          if (text === '' && !f.required) break;
          out[f.key] = text;
          break;
        case 'number':
        case 'integer': {
          if (text.trim() === '') break;
          if (f.unit === 'bytes') {
            const bytes = readBytes(f, text);
            if (typeof bytes === 'string') fail(scope, f, bytes);
            else out[f.key] = bytes;
            break;
          }
          const n = Number(text.trim());
          if (!Number.isFinite(n) || (f.kind === 'integer' && !Number.isInteger(n))) {
            fail(scope, f, f.kind === 'integer' ? 'Enter a whole number.' : 'Enter a number.');
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
            fail(scope, f, `Not valid JSON: ${(err as Error).message}`);
          }
          break;
      }
    }
    return out;
  };

  return { value: readFields(fields, { prefix: '', values }), values, errors };
}

/** MB typed into a `bytes` field → whole bytes, or what is wrong with the text (the schema's bounds in MB). */
function readBytes(f: FormField, text: string): number | string {
  const mb = Number(text.trim());
  if (!Number.isFinite(mb)) return 'Enter a size in MB, like 5 or 0.5.';
  const bytes = Math.round(mb * BYTES_PER_MB);
  if (f.max !== undefined && bytes > f.max) return `At most ${mbLabel(f.max)}.`;
  if (f.min !== undefined && bytes < f.min) return f.min <= 1 ? 'Enter more than 0 MB.' : `At least ${mbLabel(f.min)}.`;
  return bytes;
}

function samePrincipals(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((p) => b.includes(p));
}

/** The JSON value equality of two config values (key order ignored). */
function jsonEqualValue(a: unknown, b: unknown): boolean {
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
function showValue(v: unknown): string {
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

// ── what the form says about a field ─────────────────────────────────────────

const LIST_KINDS: ReadonlySet<FieldKind> = new Set(['string-list', 'enum-list', 'record', 'object-list']);

/**
 * Whether the label carries the "must have a value" mark. A list, record or
 * checkbox the schema requires is always sent (an empty list, `false`), so
 * "required" there only means the key exists — how many items it needs is
 * `listRule`'s to say.
 */
export function needsValue(f: FormField): boolean {
  return f.required && !f.hidden && !LIST_KINDS.has(f.kind) && f.kind !== 'boolean' && f.kind !== 'object' && f.kind !== 'rule';
}

/** How many items a list field takes, in words (null for a field that is not a list). */
export function listRule(f: FormField): string | null {
  if (!LIST_KINDS.has(f.kind)) return null;
  const item = f.kind === 'record' ? 'entry' : 'item';
  const items = f.kind === 'record' ? 'entries' : 'items';
  const min = f.minItems ?? 0;
  const max = f.maxItems;
  const most = max !== undefined ? ` At most ${max} ${max === 1 ? item : items}.` : '';
  if (min === 0) return `Can be left empty.${most}`;
  return `Needs at least ${min} ${min === 1 ? item : items}.${most}`;
}

/** Where a field's value comes from, and what a change awaiting confirmation would make it. */
export interface FieldState {
  /** `saved`: set for this app; `default`: the module's default (nothing saved). */
  origin: 'saved' | 'default';
  /** The value once the pending change is confirmed (absent: the change leaves this field alone). */
  pending?: string;
}

function shortValue(v: unknown): string {
  const s = showValue(v);
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
}

/**
 * Per top-level leaf field (objects flattened; a record / list is one leaf):
 * saved for this app or the module's default, and its value after the
 * change awaiting confirmation (`pendingAfter`: the effective config once
 * confirmed; null / undefined when nothing waits or it no longer validates).
 */
export function fieldStates(
  fields: readonly FormField[],
  input: { stored: unknown; config: unknown; pendingAfter?: unknown }
): Record<string, FieldState> {
  const out: Record<string, FieldState> = {};
  const after = input.pendingAfter;
  for (const f of leafFields(fields)) {
    const state: FieldState = { origin: valueAt(input.stored, f.path) === undefined ? 'default' : 'saved' };
    if (after !== null && after !== undefined) {
      const next = valueAt(after, f.path);
      if (!jsonEqualValue(valueAt(input.config, f.path), next)) state.pending = shortValue(next);
    }
    out[f.path] = state;
  }
  return out;
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

// ── who may confirm ──────────────────────────────────────────────────────────

/**
 * A workspace role as the module runtime's confirming role: a
 * workspace admin (super-admins arrive as one) confirms `admin` changes too;
 * everyone else is at most an `editor`.
 */
export function confirmRoleOf(role: string | null | undefined): 'editor' | 'admin' {
  return role === 'workspace-admin' ? 'admin' : 'editor';
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
