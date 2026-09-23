/**
 * Pure view shaping for the app page (NSO-288): the lock banner, relative
 * times, the Files-tab tree, compile summaries, the apps-list filters and
 * the redirect-back guard. db-free and client-safe (the route components
 * import some of these), unit-tested in app-view.test.ts.
 */
import type { AppListItem } from './view.js';

// ── lock banner ──────────────────────────────────────────────────────────────

/** The lease as @drobek/apps reads it (only the fields shown here). */
export interface LeaseLike {
  holder_user_id: string;
  expires_at: string;
  renewed_at?: string;
}

export interface LockView {
  /** Holder's e-mail (members see each other's addresses on the members page too). */
  holder: string;
  holderIsYou: boolean;
  /** Seconds since the agent's last write; null for a lease without `renewed_at`. */
  secondsAgo: number | null;
  /** Seconds until the lease expires on its own. */
  expiresInSec: number;
}

export function shapeLock(
  lease: LeaseLike | null,
  emails: Map<string, string>,
  viewerUserId: string,
  nowMs: number
): LockView | null {
  if (!lease) return null;
  const expires = Date.parse(lease.expires_at);
  const renewed = lease.renewed_at ? Date.parse(lease.renewed_at) : Number.NaN;
  return {
    holder: emails.get(lease.holder_user_id) ?? 'a former member',
    holderIsYou: lease.holder_user_id === viewerUserId,
    secondsAgo: Number.isNaN(renewed) ? null : Math.max(0, Math.round((nowMs - renewed) / 1000)),
    expiresInSec: Number.isNaN(expires) ? 0 : Math.max(0, Math.round((expires - nowMs) / 1000)),
  };
}

/** "just now", "42 s ago", "3 min ago", "2 h ago", "5 d ago". */
export function formatAgo(seconds: number): string {
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

// ── compile summary ──────────────────────────────────────────────────────────

export interface CompileSummary {
  count: number;
  /** The first message as `file:line:col text` (for the table cell). */
  first: string | null;
}

export function compileSummary(errors: unknown): CompileSummary {
  if (!Array.isArray(errors) || errors.length === 0) return { count: 0, first: null };
  const e = errors[0] as { file?: unknown; line?: unknown; column?: unknown; text?: unknown; message?: unknown };
  const where = [e.file, e.line, e.column].filter((p) => p !== null && p !== undefined && p !== '').join(':');
  const text = String(e.text ?? e.message ?? '').split('\n')[0].slice(0, 200);
  return { count: errors.length, first: [where, text].filter(Boolean).join(' ') || null };
}

// ── files tree ───────────────────────────────────────────────────────────────

export interface TreeFile {
  path: string;
  size: number;
  kind: 'source' | 'built';
}

export interface TreeNode {
  /** Last path segment. */
  name: string;
  /** Full path for files; the folder prefix for folders. */
  path: string;
  size?: number;
  children?: TreeNode[];
}

/** One kind's files as a folder tree: folders first, then files, each A→Z. */
export function buildFileTree(files: TreeFile[], kind: 'source' | 'built'): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [] };
  for (const f of files) {
    if (f.kind !== kind) continue;
    const parts = f.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const prefix = parts.slice(0, i + 1).join('/');
      let next = node.children!.find((c) => c.children && c.path === prefix);
      if (!next) {
        next = { name: parts[i], path: prefix, children: [] };
        node.children!.push(next);
      }
      node = next;
    }
    node.children!.push({ name: parts[parts.length - 1], path: f.path, size: f.size });
  }
  const sort = (nodes: TreeNode[]): TreeNode[] =>
    nodes
      .sort((a, b) => Number(!!b.children) - Number(!!a.children) || a.name.localeCompare(b.name))
      .map((n) => (n.children ? { ...n, children: sort(n.children) } : n));
  return sort(root.children!);
}

/** The file a Files tab opens when none is picked: index.html, else the first source file. */
export function defaultFile(files: TreeFile[]): { path: string; kind: 'source' | 'built' } | null {
  const index = files.find((f) => f.kind === 'source' && f.path === 'index.html');
  const first = index ?? files.find((f) => f.kind === 'source') ?? files[0];
  return first ? { path: first.path, kind: first.kind } : null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

// ── apps list filters ────────────────────────────────────────────────────────

export type AppStatusFilter = 'all' | 'published' | 'unpublished';
export type AppSort = 'updated' | 'created' | 'name';

export interface AppListFilters {
  q: string;
  status: AppStatusFilter;
  sort: AppSort;
}

export function parseAppListFilters(params: URLSearchParams): AppListFilters {
  const status = params.get('status');
  const sort = params.get('sort');
  return {
    q: (params.get('q') ?? '').trim().slice(0, 100),
    status: status === 'published' || status === 'unpublished' ? status : 'all',
    sort: sort === 'created' || sort === 'name' ? sort : 'updated',
  };
}

const lastActivity = (a: AppListItem) => Date.parse(a.lastChangeAt ?? a.createdAt);

/**
 * Filter + sort the (live — deleted apps never reach the list) apps: a
 * case-insensitive search over name and slug, published / unpublished, and
 * newest activity / newest created / name A→Z (slug as the tie-break).
 */
export function filterApps(items: AppListItem[], f: AppListFilters): AppListItem[] {
  const q = f.q.toLowerCase();
  const kept = items.filter(
    (a) =>
      (!q || a.slug.includes(q) || (a.name ?? '').toLowerCase().includes(q)) &&
      (f.status === 'all' || (f.status === 'published') === a.published)
  );
  const byName = (a: AppListItem) => (a.name ?? a.slug).toLowerCase();
  return kept.sort((a, b) => {
    const d =
      f.sort === 'name'
        ? byName(a).localeCompare(byName(b))
        : f.sort === 'created'
          ? Date.parse(b.createdAt) - Date.parse(a.createdAt)
          : lastActivity(b) - lastActivity(a);
    return d || a.slug.localeCompare(b.slug);
  });
}

// ── redirects ────────────────────────────────────────────────────────────────

/**
 * Where an app action returns to: `raw` only when it is a path under the
 * app's own base path (a tab of this app), else the base path. Never an
 * absolute / protocol-relative URL (no open redirect).
 */
export function safeRedirectTo(raw: unknown, basePath: string): string {
  if (typeof raw !== 'string' || raw.length > 500) return basePath;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return basePath;
  const path = raw.split(/[?#]/)[0];
  if (path !== basePath && !path.startsWith(`${basePath}/`)) return basePath;
  if (path.split('/').includes('..')) return basePath;
  return raw;
}
