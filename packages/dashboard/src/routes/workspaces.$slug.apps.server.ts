/**
 * GET /workspaces/:slug/apps — server half.
 * The workspace APPS LIST. Requires viewer+ via the tenancy role
 * middleware (super-admin override; unknown slug / non-member → 404;
 * anonymous → /login redirect). Deleted apps never appear. Filters come from
 * the query string: `q` (name / slug search), `status`
 * (all | published | unpublished), `sort` (updated | created | name);
 * `deleted=<slug>` shows the notice after a delete. Each app carries its
 * thumbnail: the URL the list frames, or a placeholder reason.
 * While the workspace may not publish (blocked by the operator, or
 * not approved yet) the list shows the notice; POST `request-publish-approval`
 * (editor+) asks the operator for an approval.
 */
import { data, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import { deletionWindow, previewUrl, publishedUrl, validateAppSlug } from '@drobek/apps';
import { requireWorkspaceRole, roleAtLeast, workspaceNav } from '@drobek/tenancy';
import { listWorkspaceApps } from '../apps.server.js';
import { filterApps, parseAppListFilters } from '../app-view.js';
import { appThumbnail, shapeApps } from '../view.js';
import { publishApprovalView, requestApprovalAction } from '../publish-approval.server.js';

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(
    request,
    String(params.slug ?? ''),
    'viewer'
  );

  const url = new URL(request.url);
  const filters = parseAppListFilters(url.searchParams);
  const all = shapeApps(await listWorkspaceApps(access.workspace.id));
  const deleted = url.searchParams.get('deleted') ?? '';
  const deletion = deletionWindow();

  return {
    workspace: {
      slug: access.workspace.slug,
      name: access.workspace.name,
      kind: access.workspace.kind,
    },
    /** The shared workspace chrome (breadcrumb, badges, tabs). */
    nav: await workspaceNav(access),
    apps: filterApps(all, filters).map((app) => ({
      ...app,
      // The sandboxed iframe thumbnail (or why it is a placeholder).
      thumbnail: appThumbnail(app, { published: publishedUrl(app.slug), preview: previewUrl(app.slug) }),
    })),
    total: all.length,
    filters,
    // Only echo something that looks like a slug (never arbitrary text).
    deletedSlug: deleted && validateAppSlug(deleted) === null ? deleted : null,
    slugReleaseDays: deletion.slugReservedDays,
    purgeDays: deletion.purgeDays,
    role: access.effectiveRole,
    publishApproval: await publishApprovalView(access.workspace.id, access.user.id),
    canRequestApproval: roleAtLeast(access.effectiveRole, 'editor'),
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'viewer');
  const base = `/workspaces/${access.workspace.slug}/apps`;
  const out = await requestApprovalAction(access, await request.formData(), { base, fallback: base });
  return out ?? data({ error: 'Unknown action.' }, { status: 400 });
}
