/**
 * The server half of the workspace chrome (NSO-342): what <WorkspacePage>
 * (./layout.tsx) shows for a resolved workspace access — name, kind, your
 * effective role and which admin-only tabs to list. The routes behind those
 * tabs gate themselves; this only hides links nobody may open.
 */
import type { WorkspaceAccess } from './membership.server.js';

/** What the workspace chrome shows. */
export interface WorkspaceNav {
  slug: string;
  name: string;
  kind: string;
  role: string;
  canViewActivity: boolean;
  canManageUpstreams: boolean;
}

export function workspaceNav(access: WorkspaceAccess): WorkspaceNav {
  // A super-admin's effective role is already 'workspace-admin'.
  const admin = access.effectiveRole === 'workspace-admin';
  return {
    slug: access.workspace.slug,
    name: access.workspace.name,
    kind: access.workspace.kind,
    role: access.effectiveRole,
    canViewActivity: admin,
    canManageUpstreams: admin,
  };
}
