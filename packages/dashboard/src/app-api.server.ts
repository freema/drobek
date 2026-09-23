/**
 * The guards of the owner-facing app APIs (`POST /api/apps/:id/…`, M1-01 /
 * M1-02) — ONE implementation for the pending module-change decision and the
 * end-user session revocation. In order, before anything changes:
 *
 *   1. POST only (anything else 405);
 *   2. a dashboard session (401 JSON — an API, no /login redirect);
 *   3. Origin: REQUIRED and the dashboard's own (403 otherwise) — stricter
 *      than the global CSRF middleware, which lets Origin-less clients pass;
 *   4. the app (live, by id) and the caller's role in ITS workspace: unknown
 *      app / not a member → the same 404 (anti-enumeration); below editor →
 *      403; editor, workspace-admin and super-admin pass.
 */
import { data } from 'react-router';
import { and, eq, isNull } from 'drizzle-orm';
import { dashboardOrigin, hostConfig } from '@drobek/apps';
import { decideOriginCheck, getSessionUser, isSuperAdmin, type SessionUser } from '@drobek/auth';
import { apps, getDb, workspaces } from '@drobek/db';
import { decideWorkspaceAccess, getMembership } from '@drobek/tenancy';

export const NO_STORE = { 'Cache-Control': 'no-store' };

export function apiError(status: number, error: string, message: string, extra: Record<string, unknown> = {}) {
  return data({ ok: false, error, message, ...extra }, { status, headers: NO_STORE });
}

export interface ApiApp {
  id: string;
  slug: string;
  workspaceId: string;
  workspaceSlug: string;
}

async function findLiveApp(appId: string): Promise<ApiApp | null> {
  const [row] = await getDb()
    .select({ id: apps.id, slug: apps.slug, workspaceId: apps.workspaceId, workspaceSlug: workspaces.slug })
    .from(apps)
    .innerJoin(workspaces, eq(workspaces.id, apps.workspaceId))
    .where(and(eq(apps.id, appId), isNull(apps.deletedAt)))
    .limit(1);
  return row ?? null;
}

export type AppApiAuth =
  | { ok: true; user: SessionUser; app: ApiApp }
  | { ok: false; response: ReturnType<typeof apiError> };

/**
 * Run guards 1–4 for `appId`. `forbidden` is the 403 message for a member
 * below editor (e.g. "Confirming module changes needs the editor role…").
 */
export async function authorizeAppApi(request: Request, appId: string, forbidden: string): Promise<AppApiAuth> {
  if (request.method.toUpperCase() !== 'POST') {
    return { ok: false, response: apiError(405, 'method_not_allowed', 'Use POST.') };
  }
  const user = await getSessionUser(request);
  if (!user) return { ok: false, response: apiError(401, 'unauthorized', 'Sign in to the drobek dashboard first.') };

  const origin = request.headers.get('origin');
  const originCheck = decideOriginCheck({
    method: 'POST',
    path: new URL(request.url).pathname,
    origin,
    secFetchSite: request.headers.get('sec-fetch-site'),
    host: request.headers.get('host'),
    dashboardOrigin: dashboardOrigin(),
    hosts: hostConfig(),
  });
  if (!origin || !originCheck.ok) {
    return { ok: false, response: apiError(403, 'forbidden', 'Cross-origin request refused: use the drobek dashboard.') };
  }

  const app = await findLiveApp(appId);
  const membership = app ? await getMembership(user.id, app.workspaceId) : null;
  const access = decideWorkspaceAccess({
    membershipRole: membership?.role ?? null,
    superAdmin: isSuperAdmin(user.email),
    minRole: 'editor',
  });
  if (!app || (!access.ok && access.status === 404)) return { ok: false, response: apiError(404, 'not_found', 'Not found') };
  if (!access.ok) return { ok: false, response: apiError(403, 'forbidden', forbidden) };
  return { ok: true, user, app };
}
