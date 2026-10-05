/**
 * @drobek/audit — pure, db-free actor + action vocabulary. Safe to
 * import from client OR server code (no @drobek/db pull). The server write/read
 * modules (*.server.ts) and the dashboard shaping both build on these.
 */

/**
 * Mirrors the `audit_actor_kind` pg enum. `end_user` = a signed-in end
 * user of an app acting through a platform module on the apps origin.
 */
export type AuditActorKind = 'user' | 'agent' | 'end_user';

/** Every actor kind, in display order — the Activity view's actor filter. */
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
 * platform-module request on an app host, made by the app's end user.
 */
export function actorKindForSurface(surface: AuditSurface): AuditActorKind {
  if (surface === 'mcp') return 'agent';
  if (surface === 'apps') return 'end_user';
  return 'user';
}

/**
 * The audit action vocabulary. The column is free text, so the set stays open.
 */
export const AUDIT_ACTIONS = {
  appCreate: 'app.create',
  appVersionWrite: 'app.version.write',
  appVersionRestore: 'app.version.restore',
  /** The history retention deleted old versions of an app (system; meta: count + the first and last number). */
  appVersionsPrune: 'app.versions.prune',
  /** A member kept a version, so neither the retention nor a clean-up deletes it (meta: version). */
  appVersionKeep: 'app.version.keep',
  /** A member stopped keeping a version (meta: version). */
  appVersionUnkeep: 'app.version.unkeep',
  /** A member deleted old versions of an app (meta: count, the first and last number, failedOnly). */
  appVersionsDelete: 'app.versions.delete',
  appPublish: 'app.publish',
  /** Legacy upload pipeline — kept so historic rows still label. */
  deployActivate: 'deploy.activate',
  /** Legacy upload pipeline. */
  deployRollback: 'deploy.rollback',
  memberInvite: 'member.invite',
  memberAccept: 'member.accept',
  memberRoleChange: 'member.role_change',
  /** A workspace admin removed a member (meta: the role they had). */
  memberRemove: 'member.remove',
  /** A member left the workspace (meta: the role they had). */
  memberLeave: 'member.leave',
  /** A workspace admin revoked a pending invite (meta: its role, never the address). */
  memberInviteRevoke: 'member.invite_revoke',
  /**
   * A workspace was deleted with its apps (target = its slug; meta: app and
   * member counts, `with_account` when its owner's account deletion took it).
   * Written to the deleted workspace's own trail and to the actor's personal workspace.
   */
  workspaceDelete: 'workspace.delete',
  /** A user deleted their account (target = the user id; meta: the workspaces deleted with it, the ones left). */
  accountDelete: 'account.delete',
  /**
   * A user changed their sign-in e-mail after a code sent to the new address
   * (target = the user id; never an address; meta.super_admin `gained` |
   * `lost` when SUPERADMIN_EMAIL made that change too). Personal workspace.
   */
  accountEmailChange: 'account.email_change',
  /** `configure_module` applied a module config change directly. */
  moduleConfigure: 'module.configure',
  /** `configure_module` stored a change that needs the owner's confirmation. */
  modulePending: 'module.pending',
  /** The owner confirmed a pending module change in the dashboard. */
  moduleConfirm: 'module.confirm',
  /** The owner rejected a pending module change in the dashboard. */
  moduleReject: 'module.reject',
  /** An end user signed in to an app (platform module auth, actor end_user). */
  authSignIn: 'auth.sign_in',
  /** The owner (or their agent, sign_out_end_users) signed every end user of an app out (session epoch bump). */
  endUserSessionsRevoke: 'end_users.sessions_revoke',
  /** A module sent e-mail through ctx.email.send (counts and kind only — never addresses). */
  emailSend: 'email.send',
  /** An app admin exported a form's submissions as CSV (form + row count, never values). */
  formsExport: 'forms.export',
  /** An app admin exported a data collection as CSV (collection + row count). */
  dataExport: 'data.export',
  /** A workspace admin registered a proxy upstream (@drobek/proxy PROXY_AUDIT_ACTIONS). */
  proxyUpstreamCreate: 'proxy.upstream.create',
  /** A workspace admin deleted a proxy upstream. */
  proxyUpstreamDelete: 'proxy.upstream.delete',
  /** The proxy module refused a call (SSRF guard, port, rule) — upstream + reason. */
  proxyBlocked: 'proxy.blocked',
  /** A user created a personal API key (name + scopes, never the key). Personal workspace. */
  apiKeyCreate: 'api_key.create',
  /** A user revoked one of their API keys. Personal workspace. */
  apiKeyRevoke: 'api_key.revoke',
  /** A user revoked an OAuth client's access (all its tokens for that user). Personal workspace. */
  oauthClientRevoke: 'oauth_client.revoke',
  /** The production host stopped serving (published pointer cleared). */
  appUnpublish: 'app.unpublish',
  /** The app was soft-deleted (invisible everywhere; slug held 30 days). */
  appDelete: 'app.delete',
  /** A deleted app's slug was released (system; renamed to its tombstone). */
  appSlugRelease: 'app.slug_release',
  /** A deleted app was deleted for good, APP_PURGE_AFTER_DAYS after the delete (system). */
  appPurge: 'app.purge',
  /** A member removed an agent's single-writer lease (meta: the previous holder). */
  appLockRelease: 'app.lock.release',
  /** The app was made public (no password gate). */
  appVisibilityPublic: 'app.visibility.public',
  /** The app was put behind a password, or its password was changed. */
  appVisibilityPassword: 'app.visibility.password',
  /** The app's CSP frame-ancestors override changed (meta: the new value). */
  appFrameAncestors: 'app.frame_ancestors.change',
  /** An owner attached a custom domain to an app (hostname in meta). */
  domainAdd: 'domain.add',
  /** A custom domain passed its DNS verification (TXT + CNAME). */
  domainVerify: 'domain.verify',
  /** The daily DNS re-check found the records gone and dropped the verification (system). */
  domainUnverify: 'domain.unverify',
  /** An owner made a verified domain the primary one (or cleared it). */
  domainPrimary: 'domain.primary',
  /** An owner removed a custom domain (Caddy's certificate expires on its own). */
  domainRemove: 'domain.remove',
  /** The owner (or their agent, create_records) added records to a collection (collection + count, never values). */
  dataRecordCreate: 'data.record_create',
  /** The owner edited a record in the dashboard Data tab, or their agent with update_record (collection + id, never values). */
  dataRecordUpdate: 'data.record_update',
  /** The owner deleted a record in the dashboard Data tab, or their agent with delete_record. */
  dataRecordDelete: 'data.record_delete',
  /** The owner imported a CSV into a collection (collection + row count). */
  dataImport: 'data.import',
  /** The owner deleted a collection (its records and its declaration). */
  dataCollectionDelete: 'data.collection_delete',
  /**
   * The records of a removed collection were purged — on the owner's
   * confirmation of the config change that removed it, or of an orphan
   * collection from the Data tab (meta: collection + record count).
   */
  dataCollectionPurge: 'data.collection.purge',
  /** The owner deleted a form submission (the Forms tab, or their agent with delete_form_submission). */
  formsSubmissionDelete: 'forms.submission_delete',
  /** The owner (or their agent, set_end_user_role) changed an end user's role (end-user id + role, never the address). */
  endUserRole: 'end_users.role',
  /** The owner (or their agent, set_end_user_blocked) blocked an end user. */
  endUserDisable: 'end_users.disable',
  /** The owner (or their agent, set_end_user_blocked) unblocked an end user. */
  endUserEnable: 'end_users.enable',
  /** An uploaded file was deleted (by the app's end user, by the owner in the dashboard, or by their agent with delete_upload). */
  filesDelete: 'files.delete',
  /** An app asset was uploaded or replaced (name, size, sniffed type, how — never a token). */
  assetUpload: 'asset.upload',
  /** An app asset was deleted (name + size). */
  assetDelete: 'asset.delete',
  /** Someone reported an app through the public abuse form (report id + reason only). */
  abuseReport: 'abuse.report',
  /** A super-admin took an app down (unpublished + locked; meta.reason = the category). */
  adminTakedown: 'admin.takedown',
  /** A super-admin lifted a takedown (the app stays unpublished until its owner publishes). */
  adminRestore: 'admin.restore',
  /** The app was listed in the public gallery, or its gallery description changed (meta: description). */
  appGalleryListed: 'app.gallery_listed',
  /** The app left the public gallery (meta.reason: owner | unpublish | takedown). */
  appGalleryUnlisted: 'app.gallery_unlisted',
  /** A super-admin hid the app's gallery entry. */
  appGalleryHidden: 'app.gallery_hidden',
  /** A super-admin showed a hidden gallery entry again. */
  appGalleryUnhidden: 'app.gallery_unhidden',
  /** This app was created as a copy of a gallery app (meta: from = the source slug, version). */
  appDuplicate: 'app.duplicate',
  /** Someone duplicated this gallery app into their own workspace (no details about them). */
  appDuplicated: 'app.duplicated',
  /** A super-admin enabled an opt-in platform module for the workspace (meta: module). */
  moduleWorkspaceEnable: 'module.workspace_enable',
  /** A super-admin disabled an opt-in platform module for the workspace (meta: module). */
  moduleWorkspaceDisable: 'module.workspace_disable',
  /** A blocked publish (or the owner's button) asked the operator to approve the workspace for publishing. */
  publishApprovalRequest: 'workspace.publish_approval_request',
  /** A super-admin allowed the workspace to publish (its state `allowed`). */
  publishApprove: 'workspace.publish_approve',
  /** A super-admin took the workspace's publish approval back (live apps keep serving). */
  publishRevoke: 'workspace.publish_revoke',
  /** A super-admin turned publishing off for the workspace, in every mode (live apps keep serving; meta: from, to). */
  publishBlock: 'workspace.publish_block',
  /** A super-admin turned a blocked workspace's publishing back on (meta: from, to). */
  publishUnblock: 'workspace.publish_unblock',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** All known actions, for the Activity view's action filter dropdown. */
export const AUDIT_ACTION_LIST: AuditAction[] = Object.values(AUDIT_ACTIONS);

/** The kind of thing an action acts on (subject_type). Open, like the actions. */
export const AUDIT_SUBJECT_TYPES = {
  app: 'app',
  member: 'member',
  /** A personal API key (target = its id). */
  apiKey: 'api_key',
  /** An OAuth client (target = its public client_id). */
  oauthClient: 'oauth_client',
  /** A custom domain — `target` is the hostname, `meta.app` the app slug. */
  domain: 'domain',
  /** A platform module of the workspace (target = the module name). */
  module: 'module',
  /** The workspace itself (target = its slug) — publish approval, deletion. */
  workspace: 'workspace',
  /** A drobek account (target = its user id) — its deletion, its sign-in e-mail change. */
  account: 'account',
} as const;

export type AuditSubjectType =
  (typeof AUDIT_SUBJECT_TYPES)[keyof typeof AUDIT_SUBJECT_TYPES];
