/**
 * Pure helpers for the owner's module tabs of an app (M2-03): the Data tab's
 * record editor, the Forms tab's date range, the Uploads tab's sizes and
 * previews, the Logs tab's "since" window. No server imports — shared by the
 * loaders/actions and (where noted) the components; unit tested.
 */

/** The most bytes one CSV import may carry (the rows cap is RECORDS_IMPORT_MAX_ROWS). */
export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;

/** A record's own fields (no `_…` server fields) as the editor's pretty JSON. */
export function editableJson(record: Record<string, unknown>): string {
  const own: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) if (!k.startsWith('_')) own[k] = v;
  return JSON.stringify(own, null, 2);
}

/** The editor's text → the record's fields, or a message (not JSON / not an object). */
export function parseRecordJson(text: string): { ok: true; fields: Record<string, unknown> } | { ok: false; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `Not valid JSON: ${(err as Error).message}` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'A record is a JSON object, e.g. { "title": "Milk" }.' };
  }
  return { ok: true, fields: value as Record<string, unknown> };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A `YYYY-MM-DD` query value, or '' (anything else is ignored). */
export function parseDay(raw: string | null | undefined): string {
  const v = (raw ?? '').trim();
  if (!DAY_RE.test(v)) return '';
  return Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? '' : v;
}

/** An inclusive UTC day range → the `[from, to)` instants of a submissions query. */
export function dayRange(from: string, to: string): { from?: string; to?: string } {
  const out: { from?: string; to?: string } = {};
  if (from) out.from = `${from}T00:00:00.000Z`;
  if (to) out.to = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString();
  return out;
}

/** The Logs tab's windows. */
export const SINCE_OPTIONS = [
  { key: '1h', label: 'last hour', ms: 3_600_000 },
  { key: '24h', label: 'last 24 hours', ms: 86_400_000 },
  { key: '7d', label: 'last 7 days', ms: 7 * 86_400_000 },
  { key: '30d', label: 'last 30 days', ms: 30 * 86_400_000 },
] as const;

export type SinceKey = (typeof SINCE_OPTIONS)[number]['key'];

/** A `since` query value → its key (default 24h) and the window's start. */
export function sinceWindow(raw: string | null | undefined, now: Date = new Date()): { key: SinceKey; since: Date } {
  const opt = SINCE_OPTIONS.find((o) => o.key === raw) ?? SINCE_OPTIONS[1];
  return { key: opt.key, since: new Date(now.getTime() - opt.ms) };
}

/** 1536 → "1.5 KiB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** Types the dashboard shows inline (raster images only: an SVG or a PDF is never rendered on the dashboard origin). */
export const PREVIEW_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** A submission's fields as sorted `[name, text]` pairs (lists joined, null empty). */
export function submissionFields(data: Record<string, unknown>): [string, string][] {
  return Object.keys(data)
    .sort()
    .map((k) => {
      const v = data[k];
      const text = v === null || v === undefined ? '' : Array.isArray(v) ? v.map(String).join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
      return [k, text];
    });
}

/** A download file name: ASCII, no quotes/path separators, never empty. */
export function safeFilename(name: string, fallback: string): string {
  const clean = name.replace(/[^\x20-\x7e]/g, '_').replace(/[\\/"%;]/g, '_').trim().slice(0, 150);
  return clean || fallback;
}
