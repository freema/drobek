/**
 * The super-admin lists (All workspaces, /admin/abuse, /admin/publishing)
 * share their URL state: `?q=` (a server-side search), quick filters, `?sort=`
 * and `?page=` with ADMIN_LIST_PAGE rows per page. These helpers read that
 * state from the URL, build the links that change one part of it (a filter
 * change goes back to page 1) and format the "when" of a row. Client-safe:
 * no server imports.
 */

export const ADMIN_LIST_PAGE_DEFAULT = 50;
const ADMIN_LIST_PAGE_MAX = 500;
const Q_MAX = 200;

/** Rows per page of an admin list (`ADMIN_LIST_PAGE`, 1–500, default 50). */
export function adminListPageSize(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ADMIN_LIST_PAGE);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, ADMIN_LIST_PAGE_MAX) : ADMIN_LIST_PAGE_DEFAULT;
}

export interface AdminListState<S extends string> {
  /** The trimmed search text ('' = none). */
  q: string;
  sort: S;
  /** 1-based. */
  page: number;
}

/** `?q=`, `?sort=` (one of `sorts`, else the first) and `?page=` (a positive integer, else 1). */
export function parseAdminList<S extends string>(params: URLSearchParams, sorts: readonly S[]): AdminListState<S> {
  const q = (params.get('q') ?? '').trim().slice(0, Q_MAX);
  const rawSort = params.get('sort') ?? '';
  const sort = (sorts as readonly string[]).includes(rawSort) ? (rawSort as S) : sorts[0]!;
  const rawPage = params.get('page') ?? '';
  const page = /^[1-9][0-9]{0,6}$/.test(rawPage) ? Number(rawPage) : 1;
  return { q, sort, page };
}

/** One of `values` from `?<name>=`, else null (= no filter). */
export function pickParam<V extends string>(params: URLSearchParams, name: string, values: readonly V[]): V | null {
  const raw = params.get(name) ?? '';
  return (values as readonly string[]).includes(raw) ? (raw as V) : null;
}

/**
 * `path` with `params` changed by `changes` (null or '' removes one). Any
 * change other than the page itself goes back to page 1.
 */
export function adminListHref(path: string, params: Record<string, string>, changes: Record<string, string | number | null>): string {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) next.set(k, v);
  if (!('page' in changes)) next.delete('page');
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === '' || (k === 'page' && v === 1)) next.delete(k);
    else next.set(k, String(v));
  }
  const qs = next.toString();
  return qs ? `${path}?${qs}` : path;
}

/** "Showing 51–100 of 212" for page `page` of `matching` rows. */
export function pageWindow(page: number, pageSize: number, matching: number): { from: number; to: number; pages: number } {
  const pages = Math.max(1, Math.ceil(matching / pageSize));
  const from = matching === 0 ? 0 : (page - 1) * pageSize + 1;
  return { from, to: Math.min(matching, page * pageSize), pages };
}

/** The last page that still has rows (1 when there are none). */
export function lastPage(pageSize: number, matching: number): number {
  return Math.max(1, Math.ceil(matching / pageSize));
}

/** `2026-10-18 13:50 UTC` — the absolute time a relative one stands for. */
export function utcMinute(date: Date): string {
  return `${date.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

/** "just now", "5 min ago", "3 h ago", "12 days ago", "4 months ago", "2 years ago". */
export function relativeTime(date: Date, now: Date = new Date()): string {
  const sec = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.floor(h / 24);
  if (days < 60) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

/** A row's "when": the relative text, and the absolute time for its title. */
export function whenView(date: Date | null, now: Date = new Date()): { ago: string; at: string } | null {
  return date ? { ago: relativeTime(date, now), at: utcMinute(date) } : null;
}
