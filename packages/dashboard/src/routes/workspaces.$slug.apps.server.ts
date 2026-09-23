/**
 * GET /workspaces/:slug/apps — server half (U8, PHY-74 slice; filters
 * NSO-288). The workspace APPS LIST. Requires viewer+ via the tenancy role
 * middleware (super-admin override; unknown slug / non-member → 404;
 * anonymous → /login redirect). Deleted apps never appear. Filters come from
 * the query string: `q` (name / slug search), `status`
 * (all | published | unpublished), `sort` (updated | created | name);
 * `deleted=<slug>` shows the notice after a delete.
 */
import { type LoaderFunctionArgs } from 'react-router';
import { SLUG_RELEASE_AFTER_MS, validateAppSlug } from '@drobek/apps';
import { requireWorkspaceRole } from '@drobek/tenancy';
import { listWorkspaceApps } from '../apps.server.js';
import { filterApps, parseAppListFilters } from '../app-view.js';
import { shapeApps } from '../view.js';

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

  return {
    workspace: {
      slug: access.workspace.slug,
      name: access.workspace.name,
      kind: access.workspace.kind,
    },
    apps: filterApps(all, filters),
    total: all.length,
    filters,
    // Only echo something that looks like a slug (never arbitrary text).
    deletedSlug: deleted && validateAppSlug(deleted) === null ? deleted : null,
    slugReleaseDays: Math.round(SLUG_RELEASE_AFTER_MS / (24 * 60 * 60 * 1000)),
    role: access.effectiveRole,
  };
}
