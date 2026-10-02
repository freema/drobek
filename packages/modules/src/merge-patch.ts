/**
 * RFC 7396 JSON Merge Patch — how `configure_module` applies a PARTIAL config:
 * objects merge recursively, `null` removes a key, anything else (arrays,
 * scalars) replaces. Pure; never mutates its inputs.
 */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return structuredClone(patch);
  const out: Record<string, unknown> = isObject(target) ? structuredClone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

/**
 * The merge patch that turns `before` into `after` (`{}` when they are
 * equal): changed keys carry the new value, removed keys `null`, objects
 * recurse, arrays and scalars are replaced whole. `mergePatch(before, patch)`
 * gives back `after` for every `after` mergePatch can produce (no `null`
 * object values).
 */
export function diffMergePatch(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(before)) if (!Object.prototype.hasOwnProperty.call(after, key)) out[key] = null;
  for (const [key, value] of Object.entries(after)) {
    const was = before[key];
    if (Object.prototype.hasOwnProperty.call(before, key) && jsonEqual(was, value)) continue;
    if (isObject(was) && isObject(value)) out[key] = diffMergePatch(was, value);
    else out[key] = structuredClone(value);
  }
  return out;
}

/** Structural equality of two JSON values (key order does not matter). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}
