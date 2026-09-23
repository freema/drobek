/**
 * GET/POST /workspaces/:slug/apps/:appSlug — server half (PHY-74 slice).
 *
 * GET (viewer+): the app (status, visibility, published version) + its
 * VERSION HISTORY (number, author kind, compile status, reasoning, published
 * flag). A viewer sees everything but no publish control.
 *
 * POST (editor+): PUBLISH a version — publishing an older version is the
 * rollback. The role gate is enforced SERVER-SIDE by
 * requireWorkspaceRole('editor') — a viewer gets 403, a non-member 404, an
 * anonymous request a /login redirect — BEFORE @drobek/apps publish runs
 * (which moves the pointer and writes the `app.publish` audit row).
 */
import {
  data,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';
import { AppsError, listVersions, publish } from '@drobek/apps';
import { actorKindForSurface } from '@drobek/audit';
import { requireWorkspaceRole } from '@drobek/tenancy';
import {
  queryAppErrors,
  queryAppLogs,
  type AppErrorsView,
  type AppLogsView,
} from '@drobek/insights';
import { loadAppForView } from '../apps.server.js';
import { canPublish, shapeVersionHistory } from '../view.js';

const EMPTY_ERRORS: AppErrorsView = {
  totalEvents: 0,
  distinctErrors: 0,
  errors: [],
};
const EMPTY_LOGS: AppLogsView = {
  requests: 0,
  count5xx: 0,
  top404Paths: [],
  recentVersions: [],
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

  const versions = shapeVersionHistory(await listVersions(app.id, { limit: 100 }));
  const published = versions.find((v) => v.published) ?? null;

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
      publishedVersion: published?.number ?? null,
    },
    versions,
    errors,
    logs,
    role: access.effectiveRole,
    canPublish: canPublish(access.effectiveRole),
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
  const app = await loadAppForView(access.workspace.id, appSlug);
  if (!app) {
    throw data({ message: 'Not found' }, { status: 404 });
  }
  const form = await request.formData();
  const versionId = String(form.get('versionId') ?? '').trim();

  try {
    // Dashboard/web surface (PHY-85) → the publish audit is attributed to the
    // human session user. Server-derived here; the client cannot set it.
    await publish(app.id, versionId, {
      userId: access.user.id,
      kind: actorKindForSurface('web'),
    });
  } catch (err) {
    // Expected failures (not_found / not_publishable) carry a caller-safe message.
    if (err instanceof AppsError) {
      return data({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  // Reflect the new published version: bounce back to the detail page.
  return redirect(`/workspaces/${access.workspace.slug}/apps/${appSlug}`);
}
