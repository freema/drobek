/**
 * PURE authz decisions for the proxy (PHY-59) — unit tested without db.
 *
 * TWO distinct gates:
 *   - CONFIGURE (register/list/delete an upstream): workspace-admin or
 *     super-admin ONLY. editor / viewer / non-member are denied.
 *   - CALL (invoke the proxy): ANY workspace member (viewer+) or super-admin in
 *     v1. A non-member / anonymous caller is denied.
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

/** May this caller invoke the proxy? any member (viewer+) or super-admin (v1). */
export function canCallProxy(
  role: WorkspaceRole | null,
  superAdmin = false
): boolean {
  if (superAdmin) return true;
  return role !== null; // any membership role suffices in v1
}
