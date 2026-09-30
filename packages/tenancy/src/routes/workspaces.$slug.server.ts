/**
 * GET /workspaces/:slug — server half. Requires viewer+ via the
 * role middleware (super-admin override included); returns the workspace,
 * its members (email + role) and whether the invite form may be shown
 * (workspace-admin or super-admin, TEAM workspaces only).
 */
import { type LoaderFunctionArgs } from 'react-router';
import {
  listWorkspaceMembers,
  requireWorkspaceRole,
} from '../membership.server.js';
import { workspaceNav } from '../workspace-nav.js';

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(
    request,
    String(params.slug ?? ''),
    'viewer'
  );

  const members = await listWorkspaceMembers(access.workspace.id);

  return {
    workspace: {
      slug: access.workspace.slug,
      name: access.workspace.name,
      kind: access.workspace.kind,
    },
    /** The shared workspace chrome (breadcrumb, badges, tabs). */
    nav: await workspaceNav(access),
    members,
    role: access.effectiveRole,
    superAdmin: access.superAdmin,
    canInvite:
      access.effectiveRole === 'workspace-admin' &&
      access.workspace.kind === 'team',
    // The Activity (audit) view is admin/super-admin only. A super-admin's
    // effective workspace role is already 'workspace-admin', so this covers both.
    canViewActivity: access.effectiveRole === 'workspace-admin',
    // The BFF proxy Upstreams config is admin/super-admin only (same gate).
    canManageUpstreams: access.effectiveRole === 'workspace-admin',
  };
}
