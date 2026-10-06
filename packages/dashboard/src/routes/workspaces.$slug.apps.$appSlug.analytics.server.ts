/**
 * GET /workspaces/:slug/apps/:appSlug/analytics — server half of the
 * Analytics tab: the app's traffic on its production address and custom
 * domains over `?days=7|30|90` (within ANALYTICS_RETENTION_DAYS; default 30)
 * — page views and estimated visitors per day, totals, the bot share, top
 * pages and top referrer hosts. The same reader as the MCP `get_analytics`
 * tool; today's live counters are merged in, so the tab is current. Viewer+;
 * read-only. A failed read shows an error instead of an empty range.
 */
import { type LoaderFunctionArgs } from 'react-router';
import { TRAFFIC_RANGES, analyticsEnabled, analyticsRetentionDays, queryTraffic, type TrafficView } from '@drobek/insights';
import { requireWorkspaceRole } from '@drobek/tenancy';
import { dbErrorForLog } from '@drobek/db';
import { appHeaderFor } from '../app-page.server.js';
import { ownerApp } from '../owner-http.server.js';
import { analyticsDays, analyticsRanges } from '../analytics-view.js';

/** Seams for the loader test. */
export const analyticsTabDeps = {
  read: (appId: string, days: number): Promise<TrafficView> => queryTraffic(appId, days),
  env: (): NodeJS.ProcessEnv => process.env,
};

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'viewer');
  const app = await ownerApp(access, String(params.appSlug ?? ''));
  const env = analyticsTabDeps.env();
  const enabled = analyticsEnabled(env);
  const retentionDays = analyticsRetentionDays(env);
  const ranges = analyticsRanges(TRAFFIC_RANGES, retentionDays);
  const days = analyticsDays(new URL(request.url).searchParams.get('days'), ranges);
  let traffic: TrafficView | null = null;
  let error: string | null = null;
  if (enabled) {
    try {
      traffic = await analyticsTabDeps.read(app.id, days);
    } catch (err) {
      console.error('[dashboard] analytics read failed', dbErrorForLog(err, { stack: true }));
      error = 'The visit counts could not be loaded, so nothing is shown for this range. Reload the page; if it keeps failing, the server log says why.';
    }
  }
  const header = await appHeaderFor(access, app.slug);
  return {
    header,
    appSlug: app.slug,
    enabled,
    retentionDays,
    ranges,
    days,
    published: header.publishedVersion !== null,
    traffic,
    error,
  };
}
