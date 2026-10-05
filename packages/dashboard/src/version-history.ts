/**
 * The query parameters of the app page's version history, pure and
 * client-safe: the page cursor (`?before=`), the clean-up preview
 * (`?cleanup=<N>&failedOnly=1`) and the result banner the action redirects to
 * after a keep, an unkeep or a clean-up.
 */

/** The largest number an `app_versions.number` (a Postgres integer) can hold. */
const MAX_VERSION_NUMBER = 2_147_483_647;

/** A version number from a form field or query parameter, or null when it is not one. */
export function parseVersionNumber(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw).trim();
  if (!/^\d{1,10}$/.test(text)) return null;
  const n = Number(text);
  return n > 0 && n <= MAX_VERSION_NUMBER ? n : null;
}

/** How many versions ranges like ["3-41", "45"] cover. */
export function countRanges(ranges: readonly string[]): number {
  let n = 0;
  for (const r of ranges) {
    const [a, b] = r.split('-').map(Number);
    n += b === undefined ? 1 : b - a + 1;
  }
  return n;
}

/** Ranges for display: "3-41" → "v3–v41". */
export function rangeLabel(ranges: readonly string[]): string {
  return ranges.map((r) => r.split('-').map((n) => `v${n}`).join('–')).join(', ');
}

export type VersionResult =
  | { kind: 'kept'; number: number }
  | { kind: 'unkept'; number: number; prunable: boolean }
  | { kind: 'deleted'; count: number; ranges: string[]; failedOnly: boolean; stayed: number };

const RESULT_KEYS = ['keptVersion', 'unkeptVersion', 'prunable', 'deletedCount', 'deletedRanges', 'deletedFailedOnly', 'stayed'];
const CLEANUP_KEYS = ['cleanup', 'failedOnly'];
const RANGES = /^\d{1,10}(-\d{1,10})?(,\d{1,10}(-\d{1,10})?){0,49}$/;

/** The result banner a redirect after a keep, unkeep or clean-up asks for; null when there is none. */
export function versionResultFrom(params: URLSearchParams): VersionResult | null {
  const kept = parseVersionNumber(params.get('keptVersion'));
  if (kept) return { kind: 'kept', number: kept };
  const unkept = parseVersionNumber(params.get('unkeptVersion'));
  if (unkept) return { kind: 'unkept', number: unkept, prunable: params.get('prunable') === '1' };
  const raw = params.get('deletedCount');
  if (raw !== null && /^\d{1,10}$/.test(raw)) {
    const rangesRaw = params.get('deletedRanges') ?? '';
    const stayed = Number(params.get('stayed') ?? '0');
    return {
      kind: 'deleted',
      count: Number(raw),
      ranges: RANGES.test(rangesRaw) ? rangesRaw.split(',') : [],
      failedOnly: params.get('deletedFailedOnly') === '1',
      stayed: Number.isSafeInteger(stayed) && stayed > 0 ? stayed : 0,
    };
  }
  return null;
}

/**
 * `path` (a path with an optional query, already checked to be this app's)
 * with the result banner's parameters replaced by `result` and the clean-up
 * preview closed.
 */
export function withVersionResult(path: string, result: Record<string, string>): string {
  const url = new URL(path, 'http://dashboard.invalid');
  for (const k of [...RESULT_KEYS, ...CLEANUP_KEYS]) url.searchParams.delete(k);
  for (const [k, v] of Object.entries(result)) url.searchParams.set(k, v);
  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ''}`;
}
