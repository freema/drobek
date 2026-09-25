/**
 * GET /workspaces/:slug/apps/:appSlug/logs — server half of the Logs tab
 * (M2-03): the SAME readers as the `get_logs` MCP tool (@drobek/insights) —
 * browser runtime errors (deduped, with counts), the last compiles, and the
 * per-day request totals (module calls by status class) — for a window picked
 * from `?since=1h|24h|7d|30d` (default 24h). Viewer+; no mutations; no
 * realtime (the page has a Refresh button; a beacon is stored synchronously,
 * so an error raised in preview shows on the next load).
 *
 * Each section is read on its own: one failing reader (e.g. Redis down for the
 * request counters) shows its error and leaves the others intact.
 */
import { type LoaderFunctionArgs } from 'react-router';
import { queryCompileLog, queryRequestLog, queryRuntimeLog } from '@drobek/insights';
import { requireWorkspaceRole } from '@drobek/tenancy';
import { appHeaderFor } from '../app-page.server.js';
import { dbErrorForLog } from '@drobek/db';
import { ownerApp } from '../owner-http.server.js';
import { SINCE_OPTIONS, sinceWindow } from '../owner-view.js';

type Section<T> = { entries: T[]; error: string | null };

async function section<T>(read: () => Promise<T[]>): Promise<Section<T>> {
  try {
    return { entries: await read(), error: null };
  } catch (err) {
    console.error('[dashboard] logs section failed', dbErrorForLog(err, { stack: true }));
    return { entries: [], error: 'This section could not be loaded — try Refresh.' };
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'viewer');
  const app = await ownerApp(access, String(params.appSlug ?? ''));
  const now = new Date();
  const { key, since } = sinceWindow(new URL(request.url).searchParams.get('since'), now);
  const [runtime, compile, requests] = await Promise.all([
    section(() => queryRuntimeLog(app.id, since, now)),
    section(() => queryCompileLog(app.id, since, now)),
    section(() => queryRequestLog(app.id, since, { now })),
  ]);
  return {
    workspace: { slug: access.workspace.slug, name: access.workspace.name },
    appSlug: app.slug,
    /** NSO-342: the app header + tabs on every app sub-page. */
    header: await appHeaderFor(access, app.slug),
    since: key,
    sinceOptions: SINCE_OPTIONS.map((o) => ({ key: o.key, label: o.label })),
    loadedAt: now.toISOString(),
    runtime,
    compile,
    requests,
  };
}
