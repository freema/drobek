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
  /** M2-01: the production host stopped serving (published pointer cleared). */
  appUnpublish: 'app.unpublish',
  /** M2-01: the app was soft-deleted (invisible everywhere; slug held 30 days). */
  appDelete: 'app.delete',
  /** M2-01: a deleted app's slug was released (system; renamed to its tombstone). */
  appSlugRelease: 'app.slug_release',
  /** M2-01: a member removed an agent's single-writer lease (meta: the previous holder). */
  appLockRelease: 'app.lock.release',
  /** M2-01: the app was made public (no password gate). */
  appVisibilityPublic: 'app.visibility.public',
  /** M2-01: the app was put behind a password, or its password was changed. */
  appVisibilityPassword: 'app.visibility.password',
  /** M2-01: the app's CSP frame-ancestors override changed (meta: the new value). */
  appFrameAncestors: 'app.frame_ancestors.change',
  /** M3-01: an owner attached a custom domain to an app (hostname in meta). */
  domainAdd: 'domain.add',
  /** M3-01: a custom domain passed its DNS verification (TXT + CNAME). */
  domainVerify: 'domain.verify',
  /** M3-01: the daily DNS re-check found the records gone and dropped the verification (system). */
  domainUnverify: 'domain.unverify',
  /** M3-01: an owner made a verified domain the primary one (or cleared it). */
  domainPrimary: 'domain.primary',
  /** M3-01: an owner removed a custom domain (Caddy's certificate expires on its own). */
  domainRemove: 'domain.remove',
  /** M2-03: the owner edited a record in the dashboard Data tab (collection + id, never values). */
  dataRecordUpdate: 'data.record_update',
  /** M2-03: the owner deleted a record in the dashboard Data tab. */
  dataRecordDelete: 'data.record_delete',
  /** M2-03: the owner imported a CSV into a collection (collection + row count). */
  dataImport: 'data.import',
  /** M2-03: the owner deleted a collection (its records and its declaration). */
  dataCollectionDelete: 'data.collection_delete',
  /**
   * NSO-324: the records of a removed collection were purged — on the owner's
   * confirmation of the config change that removed it, or of an orphan
   * collection from the Data tab (meta: collection + record count).
   */
  dataCollectionPurge: 'data.collection.purge',
  /** M2-03: the owner deleted a form submission. */
  formsSubmissionDelete: 'forms.submission_delete',
  /** M2-03: the owner changed an end user's role (end-user id + role, never the address). */
  endUserRole: 'end_users.role',
  /** M2-03: the owner blocked an end user. */
  endUserDisable: 'end_users.disable',
  /** M2-03: the owner unblocked an end user. */
  endUserEnable: 'end_users.enable',
  /** M1-05 / M2-03: an uploaded file was deleted (by the app's end user, or by the owner in the dashboard). */
  filesDelete: 'files.delete',
  /** M4-02: someone reported an app through the public abuse form (report id + reason only). */
  abuseReport: 'abuse.report',
  /** M4-02: a super-admin took an app down (unpublished + locked; meta.reason = the category). */
  adminTakedown: 'admin.takedown',
  /** M4-02: a super-admin lifted a takedown (the app stays unpublished until its owner publishes). */
  adminRestore: 'admin.restore',
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
  /** M3-01: a custom domain — `target` is the hostname, `meta.app` the app slug. */
  domain: 'domain',
} as const;

export type AuditSubjectType =
  (typeof AUDIT_SUBJECT_TYPES)[keyof typeof AUDIT_SUBJECT_TYPES];
