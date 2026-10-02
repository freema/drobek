/**
 * Pure shaping for the read side: the stored rows → the
 * agent-actionable + dashboard shapes. No DB / no Redis here → unit-tested.
 */
import { fileHintFromStack } from './sanitize.js';

/** Max distinct 404 paths surfaced by app_logs. */
export const TOP_404_LIMIT = 10;

export interface ErrorRow {
  dedupKey: string;
  type: string;
  message: string;
  stack: string | null;
  url: string;
  createdAt: Date;
  ts: Date | null;
  /** `module_job` rows: the module and job that failed. */
  module?: string | null;
  job?: string | null;
  /** The app version the reporting page was served from (null = unknown). */
  versionNumber?: number | null;
}

export interface DedupedError {
  dedupKey: string;
  type: string;
  message: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  lastUrl: string;
  /** The version of the page of the latest occurrence (null = unknown). */
  lastVersion: number | null;
  /** `file:line:col` extracted from the most recent stack, when present. */
  fileHint: string | null;
  /** `module_job` errors: the module and job that failed (absent for browser errors). */
  module?: string;
  job?: string;
}

export interface AppErrorsView {
  totalEvents: number;
  distinctErrors: number;
  errors: DedupedError[];
}

/**
 * Group error rows by dedup key → counts + first/last seen + a file hint.
 * `rows` are expected newest-first (as queried); the shape is stable regardless.
 * Sorted by count desc, then most-recent lastSeen.
 */
export function dedupErrors(rows: ErrorRow[]): AppErrorsView {
  const byKey = new Map<string, DedupedError & { _lastAt: number; _firstAt: number }>();
  for (const r of rows) {
    const at = r.createdAt.getTime();
    const existing = byKey.get(r.dedupKey);
    if (!existing) {
      byKey.set(r.dedupKey, {
        dedupKey: r.dedupKey,
        type: r.type,
        message: r.message,
        count: 1,
        firstSeen: r.createdAt.toISOString(),
        lastSeen: r.createdAt.toISOString(),
        lastUrl: r.url,
        lastVersion: r.versionNumber ?? null,
        fileHint: fileHintFromStack(r.stack),
        ...(r.module ? { module: r.module } : {}),
        ...(r.job ? { job: r.job } : {}),
        _lastAt: at,
        _firstAt: at,
      });
      continue;
    }
    existing.count += 1;
    if (at > existing._lastAt) {
      existing._lastAt = at;
      existing.lastSeen = r.createdAt.toISOString();
      existing.lastUrl = r.url;
      existing.lastVersion = r.versionNumber ?? null;
      existing.message = r.message;
      existing.fileHint = fileHintFromStack(r.stack) ?? existing.fileHint;
    }
    if (at < existing._firstAt) {
      existing._firstAt = at;
      existing.firstSeen = r.createdAt.toISOString();
    }
  }

  const errors = [...byKey.values()]
    .map(({ _lastAt, _firstAt, ...rest }) => {
      void _lastAt;
      void _firstAt;
      return rest;
    })
    .sort(
      (a, b) =>
        b.count - a.count || (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0)
    );

  return {
    totalEvents: rows.length,
    distinctErrors: errors.length,
    errors,
  };
}

export interface DailyStatRow {
  requestCount: number;
  count5xx: number;
  path404Counts: Record<string, number> | null;
}

export interface VersionRow {
  id: string;
  number: number;
  compileStatus: string;
  actorKind: string;
  createdAt: Date;
}

export interface Top404 {
  path: string;
  count: number;
}

export interface RecentVersion {
  number: number;
  compileStatus: string;
  /** Who wrote it: agent (MCP) or user (dashboard). */
  actorKind: string;
  /** True for the version the production host serves. */
  published: boolean;
  createdAt: string;
}

export interface AppLogsView {
  requests: number;
  count5xx: number;
  top404Paths: Top404[];
  recentVersions: RecentVersion[];
}

/** Aggregate the per-day signal rows + recent versions into the app_logs shape. */
export function shapeLogs(input: {
  daily: DailyStatRow[];
  versions: VersionRow[];
  publishedVersionId: string | null;
}): AppLogsView {
  let requests = 0;
  let count5xx = 0;
  const paths = new Map<string, number>();
  for (const d of input.daily) {
    requests += d.requestCount;
    count5xx += d.count5xx;
    for (const [path, n] of Object.entries(d.path404Counts ?? {})) {
      paths.set(path, (paths.get(path) ?? 0) + n);
    }
  }
  const top404Paths = [...paths.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : 1))
    .slice(0, TOP_404_LIMIT);

  const recentVersions = input.versions.map((v) => ({
    number: v.number,
    compileStatus: v.compileStatus,
    actorKind: v.actorKind,
    published: v.id === input.publishedVersionId,
    createdAt: v.createdAt.toISOString(),
  }));

  return { requests, count5xx, top404Paths, recentVersions };
}
