/**
 * GET /workspaces/:slug/apps/:appSlug/data — server half (M1b, PHY-121). The
 * app's COLLECTIONS list for the Data tab: each collection's name, live record
 * count, access mode + a short schema summary. viewer+ (the member-view path —
 * a workspace member may inspect EVERY collection regardless of access_mode, via
 * @drobek/data listCollectionsForMember; the anon access-mode gate does NOT
 * apply). Unknown slug / non-member → 404 (requireWorkspaceRole); an app in
 * another workspace → 404 (resolveApp cross-workspace guard).
 */
import { type LoaderFunctionArgs } from 'react-router';
import { listCollectionsForMember } from '@drobek/data';
import { requireWorkspaceRole } from '@drobek/tenancy';
import { withDataErrors } from './data-http.server.js';

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(
    request,
    String(params.slug ?? ''),
    'viewer'
  );
  const appSlug = String(params.appSlug ?? '');

  const collections = await withDataErrors(() =>
    listCollectionsForMember({
      wsSlug: access.workspace.slug,
      appSlug,
      workspaceId: access.workspace.id,
      role: access.effectiveRole,
    })
  );

  return {
    workspace: { slug: access.workspace.slug, name: access.workspace.name },
    appSlug,
    collections,
    role: access.effectiveRole,
  };
}
