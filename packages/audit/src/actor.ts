/**
 * @drobek/audit — pure, db-free actor + action vocabulary (PHY-85). Safe to
 * import from client OR server code (no @drobek/db pull). The server write/read
 * modules (*.server.ts) and the dashboard shaping both build on these.
 */

/**
 * Mirrors the `audit_actor_kind` pg enum. `end_user` (M1-01) = a signed-in end
 * user of an app acting through a platform module on the apps origin.
 */
export type AuditActorKind = 'user' | 'agent' | 'end_user';

/**
 * Where an audited action originated. This is the SINGLE source of truth for
 * actor_kind, resolved SERVER-SIDE at the call site — an MCP tool handler passes
 * 'mcp' (it runs on behalf of a connected agent), a dashboard/web loader/action
 * passes 'web' (it runs as the human session user). The connecting client can
 * never influence this, so agent-vs-user attribution is not spoofable.
 */
export type AuditSurface = 'mcp' | 'web' | 'apps';

/**
 * The canonical surface → actor_kind mapping (pure; unit-tested). `apps` = a
 * platform-module request on an app host, made by the app's end user (M1-01).
 */
export function actorKindForSurface(surface: AuditSurface): AuditActorKind {
  if (surface === 'mcp') return 'agent';
  if (surface === 'apps') return 'end_user';
  return 'user';
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
  appVersionWrite: 'app.version.write',
  appVersionRestore: 'app.version.restore',
  appPublish: 'app.publish',
  /** Legacy (pre-M0-02 upload pipeline) — kept so historic rows still label. */
  deployActivate: 'deploy.activate',
  /** Legacy (pre-M0-02 upload pipeline). */
  deployRollback: 'deploy.rollback',
  memberInvite: 'member.invite',
  memberAccept: 'member.accept',
  memberRoleChange: 'member.role_change',
  /** M1-01: configure_module applied a module config change directly. */
  moduleConfigure: 'module.configure',
  /** M1-01: configure_module stored a change that needs the owner's confirmation. */
  modulePending: 'module.pending',
  /** M1-01: the owner confirmed a pending module change in the dashboard. */
  moduleConfirm: 'module.confirm',
  /** M1-01: the owner rejected a pending module change in the dashboard. */
  moduleReject: 'module.reject',
  /** M1-02: an end user signed in to an app (platform module auth, actor end_user). */
  authSignIn: 'auth.sign_in',
  /** M1-02: the owner signed every end user of an app out (session epoch bump). */
  endUserSessionsRevoke: 'end_users.sessions_revoke',
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
