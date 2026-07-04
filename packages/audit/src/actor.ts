/**
 * @drobek/audit — pure, db-free actor + action vocabulary (PHY-85). Safe to
 * import from client OR server code (no @drobek/db pull). The server write/read
 * modules (*.server.ts) and the dashboard shaping both build on these.
 */

/** Mirrors the `audit_actor_kind` pg enum. */
export type AuditActorKind = 'user' | 'agent';

/**
 * Where an audited action originated. This is the SINGLE source of truth for
 * actor_kind, resolved SERVER-SIDE at the call site — an MCP tool handler passes
 * 'mcp' (it runs on behalf of a connected agent), a dashboard/web loader/action
 * passes 'web' (it runs as the human session user). The connecting client can
 * never influence this, so agent-vs-user attribution is not spoofable.
 */
export type AuditSurface = 'mcp' | 'web';

/** The canonical surface → actor_kind mapping (pure; unit-tested). */
export function actorKindForSurface(surface: AuditSurface): AuditActorKind {
  return surface === 'mcp' ? 'agent' : 'user';
}

/**
 * The audit action vocabulary. PHY-85 SURFACES the events that already exist
 * (deploy/rollback) plus the tenancy + app-create events. The set is left OPEN
 * (the column is free text) for the events that land later — U11 end-user-auth
 * config, U12 proxy upstreams, and an app-visibility change once a change path
 * exists (none does yet). Those are DEFERRED, not built here.
 */
export const AUDIT_ACTIONS = {
  appCreate: 'app.create',
  deployActivate: 'deploy.activate',
  deployRollback: 'deploy.rollback',
  memberInvite: 'member.invite',
  memberAccept: 'member.accept',
  memberRoleChange: 'member.role_change',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** All known actions, for the Activity view's action filter dropdown. */
export const AUDIT_ACTION_LIST: AuditAction[] = Object.values(AUDIT_ACTIONS);

/** The kind of thing an action acts on (subject_type). Open, like the actions. */
export const AUDIT_SUBJECT_TYPES = {
  app: 'app',
  member: 'member',
} as const;

export type AuditSubjectType =
  (typeof AUDIT_SUBJECT_TYPES)[keyof typeof AUDIT_SUBJECT_TYPES];
