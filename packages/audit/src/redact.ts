/**
 * The stored context (`meta`) of an audit row as a reader may see it: every
 * non-boolean value under a credential-like key is replaced. Writers record
 * ids, counts and names only; this is the second line for a value that
 * should never have been there. Pure and client-safe (the dashboard's
 * Activity view and the MCP `list_activity` tool read rows through it).
 */

const SENSITIVE_KEY = /secret|passw|token|authorization|cookie|api[_-]?key|private[_-]?key|credential/i;

const MAX_DEPTH = 6;

/** A copy of `meta` with every non-boolean value under a credential-like key replaced by `[redacted]`. */
export function redactAuditMeta(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) return value.map((v) => redactAuditMeta(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) && typeof v !== 'boolean' && v !== null ? '[redacted]' : redactAuditMeta(v, depth + 1);
    }
    return out;
  }
  return value;
}
