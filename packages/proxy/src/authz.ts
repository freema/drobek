/**
 * PURE authz decision for the proxy (PHY-59) — unit tested without db.
 *
 * CONFIGURE (register/list/delete an upstream): workspace-admin or super-admin
 * ONLY. editor / viewer / non-member are denied. Who may CALL an upstream is no
 * longer a workspace role: the `proxy` platform module decides it per app
 * (the app's config assigns the upstream, its `call` rule names the end users
 * — NSO-297).
 */
import { roleAtLeast, type WorkspaceRole } from '@drobek/tenancy';

/** May this role configure upstreams? admin-only (super-admin → workspace-admin). */
export function canConfigureUpstreams(
  role: WorkspaceRole | null,
  superAdmin = false
): boolean {
  if (superAdmin) return true;
  if (!role) return false;
  return roleAtLeast(role, 'workspace-admin');
}
