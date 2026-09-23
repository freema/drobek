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

/** Every actor kind, in display order — the Activity view's actor filter (M2-04). */
export const AUDIT_ACTOR_KINDS: readonly AuditActorKind[] = ['user', 'agent', 'end_user'];

/** Narrow untrusted input (a query param) to an actor kind, or null. */
export function parseActorKind(raw: string | null | undefined): AuditActorKind | null {
  const v = (raw ?? '').trim();
  return (AUDIT_ACTOR_KINDS as readonly string[]).includes(v) ? (v as AuditActorKind) : null;
}

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
  /** M1-04: a module sent e-mail through ctx.email.send (counts and kind only — never addresses). */
  emailSend: 'email.send',
  /** M1-04: an app admin exported a form's submissions as CSV (form + row count, never values). */
  formsExport: 'forms.export',
  /** M1-03: an app admin exported a data collection as CSV (collection + row count). */
  dataExport: 'data.export',
  /** PHY-59: a workspace admin registered a proxy upstream (@drobek/proxy PROXY_AUDIT_ACTIONS). */
  proxyUpstreamCreate: 'proxy.upstream.create',
  /** PHY-59: a workspace admin deleted a proxy upstream. */
  proxyUpstreamDelete: 'proxy.upstream.delete',
  /** M1-06: the proxy module refused a call (SSRF guard, port, rule) — upstream + reason. */
  proxyBlocked: 'proxy.blocked',
  /** M2-04: a user created a personal API key (name + scopes, never the key). Personal workspace. */
  apiKeyCreate: 'api_key.create',
  /** M2-04: a user revoked one of their API keys. Personal workspace. */
  apiKeyRevoke: 'api_key.revoke',
  /** M2-04: a user revoked an OAuth client's access (all its tokens for that user). Personal workspace. */
  oauthClientRevoke: 'oauth_client.revoke',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** All known actions, for the Activity view's action filter dropdown. */
export const AUDIT_ACTION_LIST: AuditAction[] = Object.values(AUDIT_ACTIONS);

/** The kind of thing an action acts on (subject_type). Open, like the actions. */
export const AUDIT_SUBJECT_TYPES = {
  app: 'app',
  member: 'member',
  /** M2-04: a personal API key (target = its id). */
  apiKey: 'api_key',
  /** M2-04: an OAuth client (target = its public client_id). */
  oauthClient: 'oauth_client',
} as const;

export type AuditSubjectType =
  (typeof AUDIT_SUBJECT_TYPES)[keyof typeof AUDIT_SUBJECT_TYPES];
