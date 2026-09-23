/**
 * POST /api/apps/:id/modules/:module/confirm|reject — the owner decides on a
 * pending platform-module change (M1-01). configure_module holds changes the
 * module marks as sensitive (confirmRequired) and hands the agent a
 * `confirm_url` (the dashboard page M2-02 renders at
 * /workspaces/<ws>/apps/<app>/modules/<module>); that page calls this API.
 *
 * Guards, in order, before anything changes:
 *   1. POST only (anything else 405);
 *   2. a dashboard session (401 JSON — an API, no /login redirect);
 *   3. Origin: REQUIRED and the dashboard's own (403 otherwise) — stricter
 *      than the global CSRF middleware, which lets Origin-less clients pass;
 *   4. the app (live, by id) and the caller's role in ITS workspace: unknown
 *      app / not a member → the same 404 (anti-enumeration); viewer → 403;
 *      editor, workspace-admin and super-admin may decide;
 *   5. the module must be active; nothing pending → 409 `nothing_pending`.
 * The change is applied (or dropped) in one transaction with the audit row
 * `module.confirm` / `module.reject`, actor_kind `user`.
 */
import { data, type ActionFunctionArgs } from 'react-router';
import { and, eq, isNull } from 'drizzle-orm';
import { dashboardOrigin, hostConfig } from '@drobek/apps';
import { decideOriginCheck, getSessionUser, isSuperAdmin } from '@drobek/auth';
import { apps, getDb, workspaces } from '@drobek/db';
import { isModuleError, moduleRuntime } from '@drobek/modules';
import { decideWorkspaceAccess, getMembership } from '@drobek/tenancy';

const DECISIONS = new Set(['confirm', 'reject']);
const NO_STORE = { 'Cache-Control': 'no-store' };

function fail(status: number, error: string, message: string, extra: Record<string, unknown> = {}) {
  return data({ ok: false, error, message, ...extra }, { status, headers: NO_STORE });
}

async function findLiveApp(appId: string) {
  const [row] = await getDb()
    .select({ id: apps.id, slug: apps.slug, workspaceId: apps.workspaceId, workspaceSlug: workspaces.slug })
    .from(apps)
    .innerJoin(workspaces, eq(workspaces.id, apps.workspaceId))
    .where(and(eq(apps.id, appId), isNull(apps.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function loader() {
  return fail(405, 'method_not_allowed', 'POST to confirm or reject a pending module change.');
}

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== 'POST') {
    return fail(405, 'method_not_allowed', 'POST to confirm or reject a pending module change.');
  }
  const decision = String(params.decision ?? '');
  if (!DECISIONS.has(decision)) return fail(404, 'not_found', 'Not found');

  const user = await getSessionUser(request);
  if (!user) return fail(401, 'unauthorized', 'Sign in to the drobek dashboard first.');

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
    return fail(403, 'forbidden', 'Cross-origin request refused: confirm from the drobek dashboard.');
  }

  const app = await findLiveApp(String(params.id ?? ''));
  const membership = app ? await getMembership(user.id, app.workspaceId) : null;
  const access = decideWorkspaceAccess({
    membershipRole: membership?.role ?? null,
    superAdmin: isSuperAdmin(user.email),
    minRole: 'editor',
  });
  if (!app || (!access.ok && access.status === 404)) return fail(404, 'not_found', 'Not found');
  if (!access.ok) return fail(403, 'forbidden', 'Confirming module changes needs the editor role in this workspace.');

  const runtime = await moduleRuntime();
  const input = { app: { id: app.id, slug: app.slug, workspaceId: app.workspaceId }, module: String(params.module ?? ''), userId: user.id };
  try {
    const out = decision === 'confirm' ? await runtime.confirm(input) : await runtime.reject(input);
    return data({ ok: true, decision, ...out }, { headers: NO_STORE });
  } catch (err) {
    if (isModuleError(err)) {
      return fail(err.status, err.code, err.message, err.details && typeof err.details === 'object' ? (err.details as Record<string, unknown>) : {});
    }
    throw err;
  }
}
