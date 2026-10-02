/**
 * Who may publish, the server half. The decision for one publish:
 *   1. the acting user is a super-admin → allowed;
 *   2. the workspace is `blocked` (`workspaces.publish_blocked_at`) → refused
 *      with `publish_blocked`, in every PUBLISH_APPROVAL mode;
 *   3. the workspace is `allowed` (`publish_approved_at`) or a super-admin is
 *      one of its members → allowed;
 *   4. otherwise the server mode: `open` → allowed, `approval` → refused with
 *      `publish_not_approved`.
 * `publish()` checks it inside its transaction, so every path that puts a
 * version on the production host (MCP publish, the dashboard publish and
 * rollback) is gated in one place; previews, versions and the rest never are.
 *
 * A `publish_not_approved` refusal (and the owner's "Request approval"
 * button) records an approval request and e-mails the operator — at most
 * once per workspace per PUBLISH_APPROVAL_REQUEST_EVERY_MS until a
 * super-admin decides (the conditional UPDATE is the dedupe, so concurrent
 * publishes send one mail). A blocked workspace never mails a request.
 * Setting the state is audited; blocking and unblocking e-mail the
 * workspace's editors and admins.
 */
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AUDIT_ACTIONS, AUDIT_SUBJECT_TYPES, writeAudit, type AuditExecutor } from '@drobek/audit';
import { createConsoleLogger, type Logger } from '@drobek/core';
import { apps, dbErrorForLog, getDb, memberships, users, workspaces } from '@drobek/db';
import { renderPlatformEmail, sendEmail, serverFootNote, type PlatformEmailInput } from '@drobek/email';
import { AppsError } from './errors.js';
import { dashboardOrigin } from './origin.js';
import {
  PUBLISH_APPROVAL_PATH,
  PUBLISH_APPROVAL_REQUEST_EVERY_MS,
  operatorContact,
  operatorEmails,
  publishApprovalMode,
  publishBlockedMessage,
  publishNotApprovedMessage,
  superAdminAddresses,
  type PublishApprovalMode,
  type WorkspacePublishing,
} from './publish-approval.js';
import type { Actor } from './types.js';

export type PublishAllowedBy = 'open' | 'allowed' | 'super_admin';

export interface PublishPermission {
  allowed: boolean;
  mode: PublishApprovalMode;
  /** The workspace's state as a super-admin set it. */
  publishing: WorkspacePublishing;
  /** Why it is allowed (null when it is not). */
  allowedBy: PublishAllowedBy | null;
  /** Why it is refused (null when it is allowed). */
  refusal: 'blocked' | 'not_approved' | null;
  /** The operator's address to show when publishing is refused. */
  contact: string | null;
  approvedAt: Date | null;
  blockedAt: Date | null;
  requestedAt: Date | null;
}

async function workspacesWithSuperAdmin(db: AuditExecutor, ids: string[], env: NodeJS.ProcessEnv): Promise<Set<string>> {
  const admins = superAdminAddresses(env);
  if (admins.length === 0 || ids.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ workspaceId: memberships.workspaceId })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(inArray(memberships.workspaceId, ids), inArray(sql`lower(${users.email})`, admins)));
  return new Set(rows.map((r) => r.workspaceId));
}

/** Is this user one of SUPERADMIN_EMAIL (by the stored address)? */
export async function isSuperAdminUser(
  db: AuditExecutor,
  userId: string | null | undefined,
  env: NodeJS.ProcessEnv
): Promise<boolean> {
  const admins = superAdminAddresses(env);
  if (!userId || admins.length === 0) return false;
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  return u !== undefined && admins.includes(u.email.trim().toLowerCase());
}

function stateOf(r: { approvedAt: Date | null; blockedAt: Date | null }): WorkspacePublishing {
  return r.blockedAt ? 'blocked' : r.approvedAt ? 'allowed' : 'default';
}

/**
 * The publish permission of each workspace in `workspaceIds` (for
 * `actorUserId` when given: a super-admin actor may always publish; without
 * it, what a member who is not a super-admin gets).
 */
export async function publishPermissions(
  workspaceIds: string[],
  opts: { env?: NodeJS.ProcessEnv; actorUserId?: string | null; db?: AuditExecutor } = {}
): Promise<Map<string, PublishPermission>> {
  const env = opts.env ?? process.env;
  const mode = publishApprovalMode(env);
  const ids = [...new Set(workspaceIds)];
  const out = new Map<string, PublishPermission>();
  if (ids.length === 0) return out;
  const db = opts.db ?? getDb();
  const [rows, withAdmin, actorIsAdmin] = await Promise.all([
    db
      .select({
        id: workspaces.id,
        approvedAt: workspaces.publishApprovedAt,
        blockedAt: workspaces.publishBlockedAt,
        requestedAt: workspaces.publishApprovalRequestedAt,
      })
      .from(workspaces)
      .where(inArray(workspaces.id, ids)),
    workspacesWithSuperAdmin(db, ids, env),
    isSuperAdminUser(db, opts.actorUserId, env),
  ]);
  const contact = operatorContact(env);
  for (const r of rows) {
    const publishing = stateOf(r);
    const allowedBy: PublishAllowedBy | null = actorIsAdmin
      ? 'super_admin'
      : publishing === 'blocked'
        ? null
        : publishing === 'allowed'
          ? 'allowed'
          : withAdmin.has(r.id)
            ? 'super_admin'
            : mode === 'open'
              ? 'open'
              : null;
    out.set(r.id, {
      allowed: allowedBy !== null,
      mode,
      publishing,
      allowedBy,
      refusal: allowedBy ? null : publishing === 'blocked' ? 'blocked' : 'not_approved',
      contact: allowedBy ? null : contact,
      approvedAt: r.approvedAt,
      blockedAt: r.blockedAt,
      requestedAt: r.requestedAt,
    });
  }
  return out;
}

/** One workspace's publish permission (see publishPermissions). */
export async function publishPermission(
  workspaceId: string,
  opts: { env?: NodeJS.ProcessEnv; actorUserId?: string | null; db?: AuditExecutor } = {}
): Promise<PublishPermission> {
  const p = (await publishPermissions([workspaceId], opts)).get(workspaceId);
  if (!p) throw new AppsError('not_found', `Workspace ${workspaceId} does not exist.`);
  return p;
}

/** The gate `publish()` runs inside its transaction: `publish_blocked` / `publish_not_approved` when the workspace may not publish. */
export async function assertMayPublish(
  db: AuditExecutor,
  workspaceId: string,
  actor: Actor,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const p = await publishPermission(workspaceId, { env, actorUserId: actor.userId, db });
  if (p.allowed) return;
  const extra = p.contact ? { contact: p.contact } : {};
  if (p.refusal === 'blocked') throw new AppsError('publish_blocked', publishBlockedMessage(p.contact), extra);
  throw new AppsError('publish_not_approved', publishNotApprovedMessage(p.contact), extra);
}

export interface PublishApprovalRequestResult {
  /** `sent` — a new request was recorded (and mailed); `pending` — one is already waiting (deduped); `not_needed` — the workspace may publish; `blocked` — the operator turned publishing off (no request). */
  status: 'sent' | 'pending' | 'not_needed' | 'blocked';
  requestedAt: Date | null;
  /** Operator e-mails handed to the transport. */
  mailed: number;
  contact: string | null;
}

type Mailer = (mail: { to: string; subject: string; text: string; html: string; replyTo?: string }) => Promise<boolean>;

const defaultMailer = (env: NodeJS.ProcessEnv): Mailer => async (mail) => (await sendEmail(mail, env)) === 'sent';

async function deliver(
  to: string[],
  mail: PlatformEmailInput & { replyTo?: string },
  env: NodeJS.ProcessEnv,
  send: Mailer,
  log: Logger,
  what: string,
  meta: Record<string, unknown>
): Promise<number> {
  const rendered = renderPlatformEmail(mail, env);
  let mailed = 0;
  for (const address of to) {
    try {
      if (await send({ to: address, subject: mail.subject, ...rendered, ...(mail.replyTo ? { replyTo: mail.replyTo } : {}) })) mailed++;
      else log.info(`${what} not e-mailed (SMTP not configured in dev)`, meta);
    } catch (err) {
      log.error(`${what} e-mail failed`, { ...meta, error: dbErrorForLog(err) });
    }
  }
  return mailed;
}

/**
 * Ask the operator to approve a workspace for publishing: record the request
 * (at most one per PUBLISH_APPROVAL_REQUEST_EVERY_MS while undecided), audit
 * it and e-mail every operator address — the workspace, the requesting
 * user's e-mail, the app (when a publish was refused) and the link to the
 * publishing page. Delivery errors are logged, never thrown. A blocked
 * workspace records and mails nothing.
 */
export async function requestPublishApproval(input: {
  workspaceId: string;
  actor: Actor;
  appName?: string | null;
  env?: NodeJS.ProcessEnv;
  log?: Logger;
  send?: Mailer;
  now?: Date;
}): Promise<PublishApprovalRequestResult> {
  const env = input.env ?? process.env;
  const log = input.log ?? createConsoleLogger('publish-approval');
  const contact = operatorContact(env);
  const permission = await publishPermission(input.workspaceId, { env, actorUserId: input.actor.userId });
  if (permission.allowed) return { status: 'not_needed', requestedAt: null, mailed: 0, contact: null };
  if (permission.refusal === 'blocked') return { status: 'blocked', requestedAt: null, mailed: 0, contact };

  const db = getDb();
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - PUBLISH_APPROVAL_REQUEST_EVERY_MS);
  const [ws] = await db
    .update(workspaces)
    .set({ publishApprovalRequestedAt: now, publishApprovalRequestedBy: input.actor.userId })
    .where(
      and(
        eq(workspaces.id, input.workspaceId),
        isNull(workspaces.publishApprovedAt),
        isNull(workspaces.publishBlockedAt),
        or(isNull(workspaces.publishApprovalRequestedAt), lt(workspaces.publishApprovalRequestedAt, cutoff))
      )
    )
    .returning({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name });
  if (!ws) return { status: 'pending', requestedAt: permission.requestedAt, mailed: 0, contact };

  await writeAudit({
    workspaceId: ws.id,
    actorUserId: input.actor.userId,
    actorKind: input.actor.kind,
    action: AUDIT_ACTIONS.publishApprovalRequest,
    subjectType: AUDIT_SUBJECT_TYPES.workspace,
    target: ws.slug,
    meta: input.appName ? { app: input.appName } : null,
  });

  const [requester] = input.actor.userId
    ? await db.select({ email: users.email }).from(users).where(eq(users.id, input.actor.userId)).limit(1)
    : [];
  const subject = `Publish approval requested: ${ws.name} (${ws.slug})`;
  const text = [
    `A workspace on your drobek server asks for permission to publish.`,
    '',
    `Workspace: ${ws.name} (${ws.slug})`,
    `Requested by: ${requester?.email ?? 'unknown'}`,
    ...(input.appName ? [`App: ${input.appName}`] : []),
  ].join('\n');
  const mailed = await deliver(
    operatorEmails(env),
    {
      subject,
      text,
      actions: [{ label: 'Allow or block it', url: `${dashboardOrigin(env)}${PUBLISH_APPROVAL_PATH}` }],
      closing:
        'Until a super-admin allows the workspace its apps can be built and previewed but not published. Further requests from this workspace within 24 hours are not e-mailed again.',
      footNote: serverFootNote('you are its operator (OPERATOR_EMAIL or a super-admin)', env),
      ...(requester?.email ? { replyTo: requester.email } : {}),
    },
    env,
    input.send ?? defaultMailer(env),
    log,
    'publish approval request',
    { workspace_id: ws.id }
  );
  log.info('publish approval requested', { event: 'publish_approval_request', workspace_id: ws.id, mailed });
  return { status: 'sent', requestedAt: now, mailed, contact };
}

/** The e-mails of a workspace's editors and workspace-admins (who can publish there; the app owners of moderation-mail.server.ts). */
export async function workspacePublisherEmails(workspaceId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.workspaceId, workspaceId), inArray(memberships.role, ['editor', 'workspace-admin'])));
  return [...new Set(rows.map((r) => r.email))];
}

function auditActionFor(from: WorkspacePublishing, to: WorkspacePublishing): string {
  if (to === 'blocked') return AUDIT_ACTIONS.publishBlock;
  if (from === 'blocked') return AUDIT_ACTIONS.publishUnblock;
  return to === 'allowed' ? AUDIT_ACTIONS.publishApprove : AUDIT_ACTIONS.publishRevoke;
}

function blockMail(
  ws: { slug: string; name: string },
  to: WorkspacePublishing,
  mode: PublishApprovalMode,
  contact: string | null
): { subject: string; text: string } {
  const reach = contact ? `contact the operator of this server: ${contact}` : 'contact the operator of this server';
  if (to === 'blocked') {
    return {
      subject: `Publishing is turned off for your workspace ${ws.name}`,
      text: [
        `The operator of this drobek server turned publishing off for your workspace ${ws.name} (${ws.slug}).`,
        '',
        'Nothing new can be published from it — neither in the dashboard nor by your coding agent. Building, versions and previews keep working; apps that are live keep serving unless the operator takes them down.',
        '',
        `If you think this is a mistake, ${reach}.`,
      ].join('\n'),
    };
  }
  const next =
    to === 'default' && mode === 'approval'
      ? 'Publishing from it needs the operator\'s approval again, like every workspace on this server: the next publish asks for it automatically.'
      : 'You can publish from it again — in the dashboard or by asking your coding agent.';
  return {
    subject: `Publishing is turned back on for your workspace ${ws.name}`,
    text: [
      `The operator of this drobek server turned publishing back on for your workspace ${ws.name} (${ws.slug}).`,
      '',
      next,
      '',
      `Questions: ${reach}.`,
    ].join('\n'),
  };
}

/**
 * A super-admin sets a workspace's publishing: `allowed`, `blocked` or
 * `default` (the server mode decides). Blocking clears an approval and vice
 * versa; `default` clears both and the approval request, so the next refused
 * publish e-mails the operator again. Apps already live keep serving (the
 * takedown is the tool for content that must go). Audited — to `blocked`:
 * `workspace.publish_block`; from `blocked`: `workspace.publish_unblock`;
 * otherwise `workspace.publish_approve` / `workspace.publish_revoke`.
 * Blocking and unblocking e-mail the workspace's editors and admins (after
 * the change committed; delivery errors are logged, never thrown).
 */
export async function setWorkspacePublishing(input: {
  workspaceId: string;
  publishing: WorkspacePublishing;
  actor: Actor;
  env?: NodeJS.ProcessEnv;
  log?: Logger;
  send?: Mailer;
}): Promise<{ changed: boolean; previous: WorkspacePublishing; publishing: WorkspacePublishing; slug: string; mailed: number }> {
  const env = input.env ?? process.env;
  const log = input.log ?? createConsoleLogger('publish-approval');
  const to = input.publishing;
  const out = await getDb().transaction(async (tx) => {
    const [ws] = await tx
      .select({
        id: workspaces.id,
        slug: workspaces.slug,
        name: workspaces.name,
        approvedAt: workspaces.publishApprovedAt,
        blockedAt: workspaces.publishBlockedAt,
      })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .for('update');
    if (!ws) throw new AppsError('not_found', `Workspace ${input.workspaceId} does not exist.`);
    const from = stateOf(ws);
    if (from === to) return { ws, from, changed: false };
    const now = new Date();
    const cleared = { publishApprovedAt: null, publishApprovedBy: null, publishBlockedAt: null, publishBlockedBy: null };
    const noRequest = { publishApprovalRequestedAt: null, publishApprovalRequestedBy: null };
    await tx
      .update(workspaces)
      .set(
        to === 'blocked'
          ? { ...cleared, ...noRequest, publishBlockedAt: now, publishBlockedBy: input.actor.userId }
          : to === 'allowed'
            ? { ...cleared, publishApprovedAt: now, publishApprovedBy: input.actor.userId }
            : { ...cleared, ...noRequest }
      )
      .where(eq(workspaces.id, ws.id));
    await writeAudit(
      {
        workspaceId: ws.id,
        actorUserId: input.actor.userId,
        actorKind: input.actor.kind,
        action: auditActionFor(from, to),
        subjectType: AUDIT_SUBJECT_TYPES.workspace,
        target: ws.slug,
        meta: { from, to },
      },
      tx
    );
    return { ws, from, changed: true };
  });

  let mailed = 0;
  if (out.changed && (to === 'blocked' || out.from === 'blocked')) {
    try {
      const recipients = await workspacePublisherEmails(out.ws.id);
      const contact = operatorContact(env);
      mailed = await deliver(
        recipients,
        {
          ...blockMail(out.ws, to, publishApprovalMode(env), contact),
          footNote: serverFootNote('you can publish from this workspace', env),
          ...(contact ? { replyTo: contact } : {}),
        },
        env,
        input.send ?? defaultMailer(env),
        log,
        to === 'blocked' ? 'publish block notice' : 'publish unblock notice',
        { workspace_id: out.ws.id }
      );
    } catch (err) {
      log.error('publish block notice failed', { workspace_id: out.ws.id, error: dbErrorForLog(err) });
    }
  }
  return { changed: out.changed, previous: out.from, publishing: to, slug: out.ws.slug, mailed };
}

export type PublishingFilter = 'requested' | 'default' | 'allowed' | 'blocked' | 'all';

export const PUBLISHING_FILTERS: readonly PublishingFilter[] = ['requested', 'default', 'allowed', 'blocked', 'all'];

export interface WorkspacePublishingEntry {
  id: string;
  slug: string;
  name: string;
  kind: 'personal' | 'team';
  createdAt: Date;
  publishing: WorkspacePublishing;
  approvedAt: Date | null;
  approvedByEmail: string | null;
  blockedAt: Date | null;
  blockedByEmail: string | null;
  requestedAt: Date | null;
  requestedByEmail: string | null;
  /** Live (not deleted) apps / of them published. */
  apps: number;
  publishedApps: number;
  /** The published apps that are not taken down (for the takedown links). */
  liveApps: { id: string; slug: string; name: string | null }[];
  /** The workspace admins' e-mails. */
  admins: string[];
  /** A super-admin is a member: it may publish without an approval (unless blocked). */
  superAdminMember: boolean;
}

/** The workspaces for the super-admin publishing page — waiting requests first, newest first. */
export async function listWorkspacePublishing(
  opts: { filter?: PublishingFilter; workspace?: string | null; limit?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<WorkspacePublishingEntry[]> {
  const env = opts.env ?? process.env;
  const filter = opts.filter ?? 'requested';
  const approver = alias(users, 'approver');
  const blocker = alias(users, 'blocker');
  const requester = alias(users, 'requester');
  const isDefault = and(isNull(workspaces.publishApprovedAt), isNull(workspaces.publishBlockedAt));
  const byFilter =
    filter === 'requested'
      ? and(isDefault, isNotNull(workspaces.publishApprovalRequestedAt))
      : filter === 'default'
        ? isDefault
        : filter === 'allowed'
          ? and(isNotNull(workspaces.publishApprovedAt), isNull(workspaces.publishBlockedAt))
          : filter === 'blocked'
            ? isNotNull(workspaces.publishBlockedAt)
            : undefined;
  const where = opts.workspace ? and(eq(workspaces.slug, opts.workspace), byFilter) : byFilter;
  const db = getDb();
  const rows = await db
    .select({
      id: workspaces.id,
      slug: workspaces.slug,
      name: workspaces.name,
      kind: workspaces.kind,
      createdAt: workspaces.createdAt,
      approvedAt: workspaces.publishApprovedAt,
      approvedByEmail: approver.email,
      blockedAt: workspaces.publishBlockedAt,
      blockedByEmail: blocker.email,
      requestedAt: workspaces.publishApprovalRequestedAt,
      requestedByEmail: requester.email,
      apps: sql<number>`(SELECT count(*) FROM ${apps} WHERE ${apps.workspaceId} = ${workspaces.id} AND ${apps.deletedAt} IS NULL)`,
      publishedApps: sql<number>`(SELECT count(*) FROM ${apps} WHERE ${apps.workspaceId} = ${workspaces.id} AND ${apps.deletedAt} IS NULL AND ${apps.publishedVersionId} IS NOT NULL)`,
      admins: sql<string | null>`(SELECT string_agg(u.email, ',' ORDER BY u.email) FROM ${memberships} m JOIN ${users} u ON u.id = m.user_id WHERE m.workspace_id = ${workspaces.id} AND m.role = 'workspace-admin')`,
    })
    .from(workspaces)
    .leftJoin(approver, eq(approver.id, workspaces.publishApprovedBy))
    .leftJoin(blocker, eq(blocker.id, workspaces.publishBlockedBy))
    .leftJoin(requester, eq(requester.id, workspaces.publishApprovalRequestedBy))
    .where(where)
    .orderBy(sql`${workspaces.publishApprovalRequestedAt} DESC NULLS LAST`, desc(workspaces.createdAt))
    .limit(Math.min(Math.max(opts.limit ?? 200, 1), 500));
  const ids = rows.map((r) => r.id);
  const [withAdmin, live] = await Promise.all([
    workspacesWithSuperAdmin(db, ids, env),
    ids.length === 0
      ? Promise.resolve([])
      : db
          .select({ workspaceId: apps.workspaceId, id: apps.id, slug: apps.slug, name: apps.name })
          .from(apps)
          .where(
            and(inArray(apps.workspaceId, ids), isNull(apps.deletedAt), isNotNull(apps.publishedVersionId), isNull(apps.lockedReason))
          )
          .orderBy(apps.slug),
  ]);
  return rows.map((r) => ({
    ...r,
    publishing: stateOf(r),
    apps: Number(r.apps),
    publishedApps: Number(r.publishedApps),
    liveApps: live.filter((a) => a.workspaceId === r.id).map(({ id, slug, name }) => ({ id, slug, name })),
    admins: r.admins ? r.admins.split(',') : [],
    superAdminMember: withAdmin.has(r.id),
  }));
}
