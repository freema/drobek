/**
 * The server half of the workspace chrome: what <WorkspacePage>
 * (./layout.tsx) shows for a resolved workspace access — name + slug, kind,
 * where your access comes from (a membership or the super-admin override),
 * the personal workspace's owner, your other workspaces for the switcher and
 * which admin-only tabs to list. The routes behind those tabs gate
 * themselves; this only hides links nobody may open.
 */
import {
  listUserWorkspaces,
  personalWorkspaceOwners,
  type WorkspaceAccess,
} from './membership.server.js';
import { describeWorkspaceAccess } from './roles.js';

/** One entry of the workspace switcher. */
interface WorkspaceSwitchItem {
  slug: string;
  name: string;
  kind: string;
  role: string;
}

/** What the workspace chrome shows. */
export interface WorkspaceNav {
  slug: string;
  name: string;
  kind: string;
  /** The access badge: the membership role, or the super-admin override. */
  role: string;
  roleSource: 'member' | 'superadmin';
  roleDetail: string;
  /** A personal workspace's owner when that is not you (a super-admin looking in). */
  ownerEmail: string | null;
  /** Your own workspaces (memberships), for the switcher. */
  switchTo: WorkspaceSwitchItem[];
  superAdmin: boolean;
  canViewActivity: boolean;
  canManageUpstreams: boolean;
}

export async function workspaceNav(access: WorkspaceAccess): Promise<WorkspaceNav> {
  // A super-admin's effective role is already 'workspace-admin'.
  const admin = access.effectiveRole === 'workspace-admin';
  const described = describeWorkspaceAccess({
    membershipRole: access.membershipRole,
    superAdmin: access.superAdmin,
  });
  const [mine, owners] = await Promise.all([
    listUserWorkspaces(access.user.id),
    access.workspace.kind === 'personal' && access.membershipRole === null
      ? personalWorkspaceOwners([access.workspace.id])
      : Promise.resolve(new Map<string, string>()),
  ]);
  return {
    slug: access.workspace.slug,
    name: access.workspace.name,
    kind: access.workspace.kind,
    role: described?.label ?? access.effectiveRole,
    roleSource: described?.source ?? 'member',
    roleDetail: described?.detail ?? '',
    ownerEmail: owners.get(access.workspace.id) ?? null,
    switchTo: mine.map(({ slug, name, kind, role }) => ({ slug, name, kind, role })),
    superAdmin: access.superAdmin,
    canViewActivity: admin,
    canManageUpstreams: admin,
  };
}
