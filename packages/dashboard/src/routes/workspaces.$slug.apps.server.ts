/**
 * GET /workspaces/:slug/apps — server half (U8, PHY-74 slice). The workspace
 * APPS LIST. Requires viewer+ via the tenancy role middleware (super-admin
 * override; unknown slug / non-member → 404; anonymous → /login redirect).
 */
import { type LoaderFunctionArgs } from 'react-router';
import { requireWorkspaceRole } from '@drobek/tenancy';
import { listWorkspaceApps } from '../apps.server.js';
import { shapeApps } from '../view.js';

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(
    request,
    String(params.slug ?? ''),
    'viewer'
  );

  const apps = await listWorkspaceApps(access.workspace.id);

  return {
    workspace: {
      slug: access.workspace.slug,
      name: access.workspace.name,
      kind: access.workspace.kind,
    },
    apps: shapeApps(apps, access.workspace.slug),
    role: access.effectiveRole,
  };
}
