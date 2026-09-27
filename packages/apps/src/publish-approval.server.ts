/**
 * Publish approval (NSO-366), the server half. With PUBLISH_APPROVAL=approval
 * a workspace may publish when:
 *   - a super-admin approved it (`workspaces.publish_approved_at`), or
 *   - one of its members is a super-admin, or
 *   - the acting user is a super-admin.
 * `publish()` checks it inside its transaction, so every path that puts a
 * version on the production host (MCP publish, the dashboard publish and
 * rollback) is gated in one place; previews, versions and the rest never are.
 *
 * A blocked publish (and the owner's "Request approval" button) records an
 * approval request and e-mails the operator — at most once per workspace per
 * PUBLISH_APPROVAL_REQUEST_EVERY_MS until a super-admin decides (the
 * conditional UPDATE is the dedupe, so concurrent publishes send one mail).
 * Approve / revoke / request are audited.
 */
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AUDIT_ACTIONS, AUDIT_SUBJECT_TYPES, writeAudit, type AuditExecutor } from '@drobek/audit';
import { createConsoleLogger, type Logger } from '@drobek/core';
import { apps, dbErrorForLog, getDb, memberships, users, workspaces } from '@drobek/db';
import { renderTextEmailHtml, sendEmail } from '@drobek/email';
import { AppsError } from './errors.js';
import { dashboardOrigin } from './origin.js';
import {
  PUBLISH_APPROVAL_PATH,
  PUBLISH_APPROVAL_REQUEST_EVERY_MS,
  operatorContact,
  operatorEmails,
  publishApprovalMode,
  publishNotApprovedMessage,
  superAdminAddresses,
  type PublishApprovalMode,
} from './publish-approval.js';
import type { Actor } from './types.js';

export type PublishAllowedBy = 'open' | 'approved' | 'super_admin';

export interface PublishPermission {
  allowed: boolean;
  mode: PublishApprovalMode;
  /** Why it is allowed (null when it is not). */
  allowedBy: PublishAllowedBy | null;
  /** The operator's address to show when publishing is not allowed. */
  contact: string | null;
  approvedAt: Date | null;
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

async function isSuperAdminUser(db: AuditExecutor, userId: string | null | undefined, env: NodeJS.ProcessEnv): Promise<boolean> {
  const admins = superAdminAddresses(env);
  if (!userId || admins.length === 0) return false;
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  return u !== undefined && admins.includes(u.email.trim().toLowerCase());
}

/**
 * The publish permission of each workspace in `workspaceIds` (for `actorUserId`
 * when given: a super-admin actor may always publish). In `open` mode this
 * reads nothing.
 */
export async function publishPermissions(
  workspaceIds: string[],
  opts: { env?: NodeJS.ProcessEnv; actorUserId?: string | null; db?: AuditExecutor } = {}
): Promise<Map<string, PublishPermission>> {
  const env = opts.env ?? process.env;
  const mode = publishApprovalMode(env);
  const ids = [...new Set(workspaceIds)];
  const out = new Map<string, PublishPermission>();
  if (mode === 'open') {
    for (const id of ids) {
      out.set(id, { allowed: true, mode, allowedBy: 'open', contact: null, approvedAt: null, requestedAt: null });
    }
    return out;
  }
  if (ids.length === 0) return out;
  const db = opts.db ?? getDb();
  const [rows, withAdmin, actorIsAdmin] = await Promise.all([
    db
      .select({ id: workspaces.id, approvedAt: workspaces.publishApprovedAt, requestedAt: workspaces.publishApprovalRequestedAt })
      .from(workspaces)
      .where(inArray(workspaces.id, ids)),
    workspacesWithSuperAdmin(db, ids, env),
    isSuperAdminUser(db, opts.actorUserId, env),
  ]);
  const contact = operatorContact(env);
  for (const r of rows) {
    const allowedBy: PublishAllowedBy | null = r.approvedAt
      ? 'approved'
      : withAdmin.has(r.id) || actorIsAdmin
        ? 'super_admin'
        : null;
    out.set(r.id, {
      allowed: allowedBy !== null,
      mode,
      allowedBy,
      contact: allowedBy ? null : contact,
      approvedAt: r.approvedAt,
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

/** The gate `publish()` runs inside its transaction: `publish_not_approved` when the workspace may not publish. */
export async function assertMayPublish(
  db: AuditExecutor,
  workspaceId: string,
  actor: Actor,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (publishApprovalMode(env) === 'open') return;
  const p = await publishPermission(workspaceId, { env, actorUserId: actor.userId, db });
  if (p.allowed) return;
  throw new AppsError('publish_not_approved', publishNotApprovedMessage(p.contact), p.contact ? { contact: p.contact } : {});
}

export interface PublishApprovalRequestResult {
  /** `sent` — a new request was recorded (and mailed); `pending` — one is already waiting (deduped); `not_needed` — the workspace may publish. */
  status: 'sent' | 'pending' | 'not_needed';
  requestedAt: Date | null;
  /** Operator e-mails handed to the transport. */
  mailed: number;
  contact: string | null;
}

type Mailer = (mail: { to: string; subject: string; text: string; replyTo?: string }) => Promise<boolean>;

const defaultMailer: Mailer = async (mail) =>
  (await sendEmail({ ...mail, html: renderTextEmailHtml({ subject: mail.subject, text: mail.text }) })) === 'sent';

/**
 * Ask the operator to approve a workspace for publishing: record the request
 * (at most one per PUBLISH_APPROVAL_REQUEST_EVERY_MS while undecided), audit
 * it and e-mail every operator address — the workspace, the requesting
 * user's e-mail, the app (when a publish was blocked) and the link to the
 * approval page. Delivery errors are logged, never thrown.
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
    '',
    `Approve or decline: ${dashboardOrigin(env)}${PUBLISH_APPROVAL_PATH}`,
    '',
    'Until a super-admin approves the workspace its apps can be built and previewed but not published. Further requests from this workspace within 24 hours are not e-mailed again.',
  ].join('\n');
  const send = input.send ?? defaultMailer;
  let mailed = 0;
  for (const to of operatorEmails(env)) {
    try {
      if (await send({ to, subject, text, ...(requester?.email ? { replyTo: requester.email } : {}) })) mailed++;
      else log.info('publish approval request not e-mailed (SMTP not configured in dev)', { workspace_id: ws.id });
    } catch (err) {
      log.error('publish approval request e-mail failed', { workspace_id: ws.id, error: dbErrorForLog(err) });
    }
  }
  log.info('publish approval requested', { event: 'publish_approval_request', workspace_id: ws.id, mailed });
  return { status: 'sent', requestedAt: now, mailed, contact };
}

/**
 * A super-admin approves (`approved: true`) or revokes a workspace's
 * publishing. Revoking clears the request too, so the next blocked publish
 * e-mails the operator again; apps already live keep serving. Audited
 * `workspace.publish_approve` / `workspace.publish_revoke` when something changed.
 */
export async function setPublishApproval(input: {
  workspaceId: string;
  approved: boolean;
  actor: Actor;
}): Promise<{ changed: boolean; approvedAt: Date | null; slug: string }> {
  return getDb().transaction(async (tx) => {
    const [ws] = await tx
      .select({ id: workspaces.id, slug: workspaces.slug, approvedAt: workspaces.publishApprovedAt })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .for('update');
    if (!ws) throw new AppsError('not_found', `Workspace ${input.workspaceId} does not exist.`);
    if (input.approved === (ws.approvedAt !== null)) return { changed: false, approvedAt: ws.approvedAt, slug: ws.slug };
    const approvedAt = input.approved ? new Date() : null;
    await tx
      .update(workspaces)
      .set(
        input.approved
          ? { publishApprovedAt: approvedAt, publishApprovedBy: input.actor.userId }
          : { publishApprovedAt: null, publishApprovedBy: null, publishApprovalRequestedAt: null, publishApprovalRequestedBy: null }
      )
      .where(eq(workspaces.id, ws.id));
    await writeAudit(
      {
        workspaceId: ws.id,
        actorUserId: input.actor.userId,
        actorKind: input.actor.kind,
        action: input.approved ? AUDIT_ACTIONS.publishApprove : AUDIT_ACTIONS.publishRevoke,
        subjectType: AUDIT_SUBJECT_TYPES.workspace,
        target: ws.slug,
      },
      tx
    );
    return { changed: true, approvedAt, slug: ws.slug };
  });
}

export type PublishApprovalFilter = 'requested' | 'not_approved' | 'approved' | 'all';

export const PUBLISH_APPROVAL_FILTERS: readonly PublishApprovalFilter[] = ['requested', 'not_approved', 'approved', 'all'];

export interface PublishApprovalEntry {
  id: string;
  slug: string;
  name: string;
  kind: 'personal' | 'team';
  createdAt: Date;
  approvedAt: Date | null;
  approvedByEmail: string | null;
  requestedAt: Date | null;
  requestedByEmail: string | null;
  /** Live (not deleted) apps / of them published. */
  apps: number;
  publishedApps: number;
  /** The workspace admins' e-mails. */
  admins: string[];
  /** A super-admin is a member: it may publish without an approval. */
  superAdminMember: boolean;
}

/** The workspaces for the super-admin approval page — waiting requests first, newest first. */
export async function listPublishApprovals(
  opts: { filter?: PublishApprovalFilter; limit?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<PublishApprovalEntry[]> {
  const env = opts.env ?? process.env;
  const filter = opts.filter ?? 'requested';
  const approver = alias(users, 'approver');
  const requester = alias(users, 'requester');
  const where =
    filter === 'requested'
      ? and(isNull(workspaces.publishApprovedAt), isNotNull(workspaces.publishApprovalRequestedAt))
      : filter === 'not_approved'
        ? isNull(workspaces.publishApprovedAt)
        : filter === 'approved'
          ? isNotNull(workspaces.publishApprovedAt)
          : undefined;
  const rows = await getDb()
    .select({
      id: workspaces.id,
      slug: workspaces.slug,
      name: workspaces.name,
      kind: workspaces.kind,
      createdAt: workspaces.createdAt,
      approvedAt: workspaces.publishApprovedAt,
      approvedByEmail: approver.email,
      requestedAt: workspaces.publishApprovalRequestedAt,
      requestedByEmail: requester.email,
      apps: sql<number>`(SELECT count(*) FROM ${apps} WHERE ${apps.workspaceId} = ${workspaces.id} AND ${apps.deletedAt} IS NULL)`,
      publishedApps: sql<number>`(SELECT count(*) FROM ${apps} WHERE ${apps.workspaceId} = ${workspaces.id} AND ${apps.deletedAt} IS NULL AND ${apps.publishedVersionId} IS NOT NULL)`,
      admins: sql<string | null>`(SELECT string_agg(u.email, ',' ORDER BY u.email) FROM ${memberships} m JOIN ${users} u ON u.id = m.user_id WHERE m.workspace_id = ${workspaces.id} AND m.role = 'workspace-admin')`,
    })
    .from(workspaces)
    .leftJoin(approver, eq(approver.id, workspaces.publishApprovedBy))
    .leftJoin(requester, eq(requester.id, workspaces.publishApprovalRequestedBy))
    .where(where)
    .orderBy(sql`${workspaces.publishApprovalRequestedAt} DESC NULLS LAST`, desc(workspaces.createdAt))
    .limit(Math.min(Math.max(opts.limit ?? 200, 1), 500));
  const withAdmin = await workspacesWithSuperAdmin(getDb(), rows.map((r) => r.id), env);
  return rows.map((r) => ({
    ...r,
    apps: Number(r.apps),
    publishedApps: Number(r.publishedApps),
    admins: r.admins ? r.admins.split(',') : [],
    superAdminMember: withAdmin.has(r.id),
  }));
}

