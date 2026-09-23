/**
 * What a form submission may contain (M1-04). A flat object of fields:
 * strings (≤ 10 000 characters), finite numbers, booleans, null, or lists of
 * strings (a multi-select, a repeated multipart name). No nested objects, no
 * files (upload through the files module and submit the id). Field names are
 * 1–64 characters without control characters; names starting with `_` are
 * reserved for the platform (`_hp` the honeypot, `_t` the time token).
 */
import { ModuleError } from '@drobek/modules';
import type { FieldValue } from './schema.js';

export const MAX_FIELDS = 50;
export const MAX_VALUE_CHARS = 10_000;
export const MAX_LIST_ITEMS = 50;
export const MAX_LIST_ITEM_CHARS = 1_000;
const NAME_BAD = /[\u0000-\u001f\u007f\u2028\u2029]/;

export interface SplitBody {
  honeypot: string;
  token: unknown;
  data: Record<string, unknown>;
}

/** Separate the platform fields (`_hp`, `_t`) from the submitted data. */
export function splitBody(body: unknown): SplitBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ModuleError('invalid_request', 'Send the form fields as a JSON object (or multipart/form-data).');
  }
  const { _hp, _t, ...data } = body as Record<string, unknown>;
  const hp = Array.isArray(_hp) ? _hp.join('') : _hp;
  return { honeypot: typeof hp === 'string' ? hp.trim() : hp == null ? '' : String(hp), token: _t, data };
}

/** Validate the data fields (400 `invalid_request` with a path per bad field). */
export function validateFields(data: Record<string, unknown>): Record<string, FieldValue> {
  const issues: { path: string; message: string }[] = [];
  const out: [string, FieldValue][] = [];
  const keys = Object.keys(data);
  if (keys.length === 0) issues.push({ path: '(root)', message: 'the form has no fields' });
  if (keys.length > MAX_FIELDS) issues.push({ path: '(root)', message: `at most ${MAX_FIELDS} fields` });
  for (const key of keys.slice(0, MAX_FIELDS)) {
    const v = data[key];
    if (key.length === 0 || key.length > 64 || NAME_BAD.test(key)) {
      issues.push({ path: key.slice(0, 64), message: 'field names are 1–64 characters without control characters' });
      continue;
    }
    if (key.startsWith('_')) {
      issues.push({ path: key, message: 'field names starting with _ are reserved' });
      continue;
    }
    if (v === null || typeof v === 'boolean') out.push([key, v]);
    else if (typeof v === 'number') {
      if (Number.isFinite(v)) out.push([key, v]);
      else issues.push({ path: key, message: 'must be a finite number' });
    } else if (typeof v === 'string') {
      if (v.length <= MAX_VALUE_CHARS) out.push([key, v]);
      else issues.push({ path: key, message: `at most ${MAX_VALUE_CHARS} characters` });
    } else if (Array.isArray(v)) {
      if (v.length <= MAX_LIST_ITEMS && v.every((x) => typeof x === 'string' && x.length <= MAX_LIST_ITEM_CHARS)) out.push([key, v as string[]]);
      else issues.push({ path: key, message: `a list of at most ${MAX_LIST_ITEMS} strings (≤ ${MAX_LIST_ITEM_CHARS} characters each)` });
    } else {
      issues.push({ path: key, message: 'must be text, a number, true/false, null or a list of texts (no objects, no files)' });
    }
  }
  if (issues.length > 0) throw new ModuleError('invalid_request', 'The form data is invalid.', { details: issues });
  // Object.fromEntries defines own properties only.
  return Object.fromEntries(out);
}

/** One field value as plain text (e-mail, CSV). */
export function fieldText(v: FieldValue | undefined): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}
