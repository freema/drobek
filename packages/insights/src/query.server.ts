/**
 * The read side (PHY-123): queryAppErrors / queryAppLogs over a RESOLVED app id,
 * plus the *ByLocator variants the MCP tools call (resolve → query, with the
 * token's workspace as the cross-workspace guard). Shaping is pure (shape.ts).
 */
import { and, desc, eq, gte } from 'drizzle-orm';
import { appDailyStats, appErrors, apps, deploys, getDb } from '@drobek/db';
import { DEFAULT_RETENTION_DAYS } from './limits.js';
import { resolveLiveApp } from './resolve.server.js';
import { flushDay, utcDay } from './signals.server.js';
import {
  dedupErrors,
  shapeLogs,
  type AppErrorsView,
  type AppLogsView,
} from './shape.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Hard cap on rows scanned for the dedup — the ring buffer keeps ≤500 anyway. */
const ERROR_SCAN_LIMIT = 1000;
const RECENT_DEPLOYS_LIMIT = 5;

function sinceDate(since: string | Date | undefined, days: number): Date {
  if (since instanceof Date && !Number.isNaN(since.getTime())) return since;
  if (typeof since === 'string') {
    const d = new Date(since);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(Date.now() - days * DAY_MS);
}

/** Deduped, counted errors for an app since `since` (default: retention window). */
export async function queryAppErrors(
  appId: string,
  opts: { since?: string | Date } = {}
): Promise<AppErrorsView> {
  const from = sinceDate(opts.since, DEFAULT_RETENTION_DAYS);
  const rows = await getDb()
    .select({
      dedupKey: appErrors.dedupKey,
      type: appErrors.type,
      message: appErrors.message,
      stack: appErrors.stack,
      url: appErrors.url,
      createdAt: appErrors.createdAt,
      ts: appErrors.ts,
    })
    .from(appErrors)
    .where(and(eq(appErrors.appId, appId), gte(appErrors.createdAt, from)))
    .orderBy(desc(appErrors.createdAt))
    .limit(ERROR_SCAN_LIMIT);
  return dedupErrors(rows);
}

/** Serving signals (requests / 5xx / top-404s) + recent deploys for an app. */
export async function queryAppLogs(
  appId: string,
  opts: { since?: string | Date } = {}
): Promise<AppLogsView> {
  // Freshen the durable table with today's Redis counters before reading.
  await flushDay(appId, utcDay());

  const from = sinceDate(opts.since, DEFAULT_RETENTION_DAYS);
  const fromDay = utcDay(from);

  const daily = await getDb()
    .select({
      requestCount: appDailyStats.requestCount,
      count5xx: appDailyStats.count5xx,
      path404Counts: appDailyStats.path404Counts,
    })
    .from(appDailyStats)
    .where(and(eq(appDailyStats.appId, appId), gte(appDailyStats.day, fromDay)));

  const [appRow] = await getDb()
    .select({ activeDeployId: apps.activeDeployId })
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1);

  const deployRows = await getDb()
    .select({
      id: deploys.id,
      state: deploys.state,
      createdAt: deploys.createdAt,
      activatedAt: deploys.activatedAt,
    })
    .from(deploys)
    .where(eq(deploys.appId, appId))
    .orderBy(desc(deploys.createdAt))
    .limit(RECENT_DEPLOYS_LIMIT);

  return shapeLogs({
    daily: daily.map((d) => ({
      requestCount: d.requestCount,
      count5xx: d.count5xx,
      path404Counts: d.path404Counts as Record<string, number> | null,
    })),
    deploys: deployRows,
    activeDeployId: appRow?.activeDeployId ?? null,
  });
}

export interface InsightsLocator {
  wsSlug: string;
  appSlug: string;
  requireWorkspaceId?: string;
  since?: string;
}

/** MCP app_errors: resolve the token-scoped app, then deduped errors. */
export async function queryAppErrorsByLocator(
  loc: InsightsLocator
): Promise<AppErrorsView & { workspace: string; app: string }> {
  const { appId } = await resolveLiveApp({
    wsSlug: loc.wsSlug,
    appSlug: loc.appSlug,
    requireWorkspaceId: loc.requireWorkspaceId,
  });
  const view = await queryAppErrors(appId, { since: loc.since });
  return { workspace: loc.wsSlug, app: loc.appSlug, ...view };
}

/** MCP app_logs: resolve the token-scoped app, then serving signals + deploys. */
export async function queryAppLogsByLocator(
  loc: InsightsLocator
): Promise<AppLogsView & { workspace: string; app: string }> {
  const { appId } = await resolveLiveApp({
    wsSlug: loc.wsSlug,
    appSlug: loc.appSlug,
    requireWorkspaceId: loc.requireWorkspaceId,
  });
  const view = await queryAppLogs(appId, { since: loc.since });
  return { workspace: loc.wsSlug, app: loc.appSlug, ...view };
}
