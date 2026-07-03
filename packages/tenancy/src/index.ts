/**
 * @drobek/tenancy — U4 workspaces (personal + team), the 3 membership roles +
 * global super-admin override, and Redis-backed invites (PHY-54; PHY-53
 * integration model): heavy logic lives HERE; apps/web in this repo AND the
 * private drobek-web app register thin route files that re-export the route
 * modules under `@drobek/tenancy/routes/*` — exactly like @drobek/auth.
 */
export {
  WORKSPACE_ROLES,
  isWorkspaceRole,
  roleRank,
  roleAtLeast,
  higherRole,
  decideWorkspaceAccess,
  type WorkspaceRole,
  type WorkspaceAccessDecision,
} from './roles.js';
export {
  SLUG_MIN,
  SLUG_MAX,
  RESERVED_SLUGS,
  validateTeamSlug,
  personalSlugBase,
  personalSlugCandidate,
} from './slug.js';
export {
  getMembership,
  getWorkspaceBySlug,
  getWorkspaceById,
  requireWorkspaceRole,
  listWorkspaceMembers,
  listUserWorkspaces,
  listAllWorkspaces,
  type WorkspaceSummary,
  type WorkspaceAccess,
  type WorkspaceMember,
  type UserWorkspace,
} from './membership.server.js';
export {
  ensurePersonalWorkspace,
  ensurePersonalWorkspaceAfterLogin,
} from './personal-workspace.server.js';
export {
  createTeamWorkspace,
  type CreateTeamResult,
} from './team-workspace.server.js';
export {
  INVITE_TTL_SEC,
  createInvite,
  getInvite,
  consumeInvite,
  resolveAcceptedRole,
  acceptInvite,
  acceptInviteUrl,
  type InviteRecord,
  type AcceptInviteResult,
} from './invites.server.js';
export {
  renderInviteEmail,
  sendInviteEmail,
  type InviteEmailVars,
  type RenderedInviteEmail,
} from './email/invite-email.server.js';
