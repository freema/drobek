/**
 * Pure shaping for the read side (PHY-123): the stored rows → the
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
}

export interface DedupedError {
  dedupKey: string;
  type: string;
  message: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  lastUrl: string;
  /** `file:line:col` extracted from the most recent stack, when present. */
  fileHint: string | null;
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
        fileHint: fileHintFromStack(r.stack),
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

export interface DeployRow {
  id: string;
  state: string;
  createdAt: Date;
  activatedAt: Date | null;
}

export interface Top404 {
  path: string;
  count: number;
}

export interface RecentDeploy {
  shortId: string;
  state: string;
  active: boolean;
  createdAt: string;
  activatedAt: string | null;
}

export interface AppLogsView {
  requests: number;
  count5xx: number;
  top404Paths: Top404[];
  recentDeploys: RecentDeploy[];
}

/** Aggregate the per-day signal rows + recent deploys into the app_logs shape. */
export function shapeLogs(input: {
  daily: DailyStatRow[];
  deploys: DeployRow[];
  activeDeployId: string | null;
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

  const recentDeploys = input.deploys.map((d) => ({
    shortId: d.id.slice(0, 8),
    state: d.state,
    active: d.id === input.activeDeployId,
    createdAt: d.createdAt.toISOString(),
    activatedAt: d.activatedAt ? d.activatedAt.toISOString() : null,
  }));

  return { requests, count5xx, top404Paths, recentDeploys };
}
