/**
 * GET/POST /workspaces/:slug/apps/:appSlug — server half (U8, PHY-74 slice).
 *
 * GET (viewer+): the app (live URL, status, visibility, active deploy) + its
 * DEPLOY HISTORY (each deploy's short id, state, created/activated time, active
 * flag, lint status). A viewer sees everything but no rollback control.
 *
 * POST (editor+): the ROLLBACK action. The role gate is enforced SERVER-SIDE by
 * requireWorkspaceRole('editor') — a viewer gets 403, a non-member 404, an
 * anonymous request a /login redirect — BEFORE @drobek/deploy's rollback runs
 * (which re-checks editor+ and writes the audit row). This is the PHY-74
 * acceptance: rollback works from the UI, and a viewer cannot roll back.
 *
 * We import rollback from the `@drobek/deploy/rollback` subpath (react/bullmq
 * free) so the web bundle never pulls the queue in — mirrors the events route.
 */
import {
  data,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';
import { requireWorkspaceRole } from '@drobek/tenancy';
import { rollback } from '@drobek/deploy/rollback';
import {
  queryAppErrors,
  queryAppLogs,
  type AppErrorsView,
  type AppLogsView,
} from '@drobek/insights';
import { listAppDeploys, loadAppForView } from '../apps.server.js';
import { canRollback, servePath, shapeDeployHistory } from '../view.js';

const EMPTY_ERRORS: AppErrorsView = {
  totalEvents: 0,
  distinctErrors: 0,
  errors: [],
};
const EMPTY_LOGS: AppLogsView = {
  requests: 0,
  count5xx: 0,
  top404Paths: [],
  recentDeploys: [],
};

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(
    request,
    String(params.slug ?? ''),
    'viewer'
  );

  const app = await loadAppForView(
    access.workspace.id,
    String(params.appSlug ?? '')
  );
  if (!app) {
    throw data({ message: 'Not found' }, { status: 404 });
  }

  const deployRows = await listAppDeploys(app.id);
  const deploys = shapeDeployHistory(deployRows, app.activeDeployId);
  const active = deploys.find((d) => d.active) ?? null;

  // PHY-123 Overview panels — recent errors + a 404/traffic summary (read-only,
  // viewer+). Best-effort: a signals hiccup degrades to empty, never 500s the
  // app-detail page. Stored text is React-escaped on render (no stored XSS).
  const [errors, logs] = await Promise.all([
    queryAppErrors(app.id).catch(() => EMPTY_ERRORS),
    queryAppLogs(app.id).catch(() => EMPTY_LOGS),
  ]);

  return {
    workspace: { slug: access.workspace.slug, name: access.workspace.name },
    app: {
      slug: app.slug,
      status: app.status,
      visibility: app.visibility,
      activeDeployId: app.activeDeployId,
      activeShortId: active?.shortId ?? null,
      url: servePath(access.workspace.slug, app.slug),
    },
    deploys,
    errors,
    logs,
    role: access.effectiveRole,
    canRollback: canRollback(access.effectiveRole),
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  // Role GATE (the PHY-74 acceptance): editor+ required. A viewer → 403, a
  // non-member → 404, anonymous → /login — thrown by the middleware here,
  // BEFORE any state changes.
  const access = await requireWorkspaceRole(
    request,
    String(params.slug ?? ''),
    'editor'
  );

  const appSlug = String(params.appSlug ?? '');
  const form = await request.formData();
  const toDeployId = String(form.get('toDeployId') ?? '').trim() || undefined;

  try {
    await rollback({
      userId: access.user.id,
      workspaceId: access.workspace.id,
      role: access.effectiveRole,
      slug: appSlug,
      toDeployId,
    });
  } catch (err) {
    // rollback throws DeployError (has a `.code`) for expected failures — e.g.
    // no_rollback_target / not_found. Surface the (non-secret) message; the
    // editor+ gate above already handled the authz case.
    const message =
      err instanceof Error ? err.message : 'Rollback failed. Please try again.';
    return data({ error: message }, { status: 400 });
  }

  // Reflect the new active deploy: bounce back to the detail page (revalidates).
  return redirect(`/workspaces/${access.workspace.slug}/apps/${appSlug}`);
}
