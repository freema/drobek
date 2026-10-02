/**
 * Deleting a workspace and deleting an account.
 *
 * A workspace admin deletes a TEAM workspace (the dashboard's Delete page,
 * the MCP tool delete_workspace); a personal workspace goes only with its
 * owner's account. Deleting a workspace:
 *  1. soft-deletes each live app (audited `app.delete`; its hosts answer 404
 *     at once) and runs the modules' onAppDelete (`hooks.onAppDelete`);
 *  2. purges every app of the workspace right away with the purge the
 *     APP_PURGE_AFTER_DAYS job runs (purgeApp: the app row and everything
 *     that references it, its asset files, its upstream assignments; audited
 *     `app.purge`) and hands the purged ids to `hooks.afterPurge` (their
 *     end-user sessions in Redis);
 *  3. deletes the workspace row — memberships, upstreams with their keys and
 *     the module opt-ins go with it (ON DELETE CASCADE) — and drops its
 *     pending invites from Redis. Audited `workspace.delete` in the
 *     workspace's own trail (audit_log has no foreign key to workspaces, so
 *     the trail stays until the retention prune) and in the actor's personal
 *     workspace, where they read it.
 * An app created while this runs makes the row delete fail on its foreign
 * key; the steps then run again.
 *
 * Deleting an account is refused while the user is the only workspace-admin
 * of a team workspace with other members (`sole_workspace_admin`). Otherwise
 * it deletes the personal workspace and every team workspace the user is the
 * only member of (as above), releases the user's app leases in the workspaces
 * they leave and audits `member.leave` (reason `account_deleted`) there, then
 * deletes the users row: memberships, API keys, OAuth codes and tokens and
 * gallery likes go with it (ON DELETE CASCADE); versions, audit rows and
 * upstreams they made stay, their author set to null. Audited
 * `account.delete`. Last, every dashboard session of the user ends.
 */
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  AppsError,
  notifyAppChanged,
  purgeApp,
  releaseUserAppLeases,
  softDeleteApp,
  type AppChangedEvent,
  type AssetDisk,
  type TakeLeaseHeldBy,
} from '@drobek/apps';
import { AUDIT_ACTIONS, AUDIT_SUBJECT_TYPES, writeAudit, type AuditActorKind } from '@drobek/audit';
import { destroyUserSessions, logger } from '@drobek/auth';
import { apps, dbErrorForLog, getDb, isForeignKeyViolation, memberships, upstreams, users, workspaces } from '@drobek/db';
import { dropWorkspaceInvites, listPendingInvites } from './invites.server.js';
import type { WorkspaceSummary } from './membership.server.js';
import type { WorkspaceRole } from './roles.js';

export type DeletionErrorCode = 'forbidden' | 'personal_workspace' | 'sole_workspace_admin' | 'workspaces_changed';

export class DeletionError extends Error {
  readonly code: DeletionErrorCode;
  /** sole_workspace_admin: the team workspaces that block the account deletion. */
  readonly blockers: { slug: string; name: string; members: number }[];

  constructor(code: DeletionErrorCode, message: string, blockers: DeletionError['blockers'] = []) {
    super(message);
    this.name = 'DeletionError';
    this.code = code;
    this.blockers = blockers;
  }
}

/** What runs around each deleted app outside this package (the module runtime, Redis). */
export interface AppDeletionHooks {
  /** After the app is soft-deleted, before it is purged: the modules' onAppDelete. Errors are logged. */
  onAppDelete?: (app: { id: string; slug: string; workspaceId: string }) => Promise<void>;
  /** After apps were purged: what lives outside the database (their end-user sessions). Errors are logged. */
  afterPurge?: (appIds: string[]) => Promise<void>;
}

interface DeletionOptions {
  hooks?: AppDeletionHooks;
  /** How the app hosts learn an app is gone (the MCP tools' notifier); notifyAppChanged by default. */
  notify?: (event: AppChangedEvent) => Promise<void>;
  /** Where the purge removes asset files (tests); ASSETS_DIR by default. */
  disk?: AssetDisk;
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];
type Executor = Tx | ReturnType<typeof getDb>;

const PERSONAL =
  'A personal workspace is deleted only together with its owner’s account (Account → Delete account). Its apps can be deleted one by one.';

const ROW_DELETE_ATTEMPTS = 3;

// ── what a deletion takes ────────────────────────────────────────────────────

export interface WorkspaceDeletionSummary {
  /** Apps that are not deleted yet. */
  apps: number;
  /** Of them, the ones with a live production address. */
  published: number;
  members: number;
  pendingInvites: number;
  upstreams: number;
}

/** What deleting the workspace removes, for the confirmation (the dashboard page, the MCP refusal). */
export async function workspaceDeletionSummary(workspaceId: string): Promise<WorkspaceDeletionSummary> {
  const db = getDb();
  const [[appRow], [memberRow], [upstreamRow], invites] = await Promise.all([
    db
      .select({
        apps: sql<number>`count(*)::int`,
        published: sql<number>`(count(*) filter (where ${apps.publishedVersionId} is not null))::int`,
      })
      .from(apps)
      .where(and(eq(apps.workspaceId, workspaceId), isNull(apps.deletedAt))),
    db.select({ n: count() }).from(memberships).where(eq(memberships.workspaceId, workspaceId)),
    db.select({ n: count() }).from(upstreams).where(eq(upstreams.workspaceId, workspaceId)),
    listPendingInvites(workspaceId).catch((err: unknown) => {
      logger.error('[tenancy] listing the pending invites failed', { err: dbErrorForLog(err) });
      return [];
    }),
  ]);
  return {
    apps: appRow?.apps ?? 0,
    published: appRow?.published ?? 0,
    members: memberRow?.n ?? 0,
    pendingInvites: invites.length,
    upstreams: upstreamRow?.n ?? 0,
  };
}

// ── deleting a workspace ─────────────────────────────────────────────────────

/** Who deletes the workspace — resolved server-side by the dashboard route or the MCP tool. */
export interface WorkspaceDeleteActor {
  userId: string;
  kind: AuditActorKind;
  /** The actor's effective role in the workspace (a super-admin acts as workspace-admin). */
  role: WorkspaceRole;
}

export interface DeletedWorkspace {
  slug: string;
  /** Slugs of the apps that were live and are deleted with it (already deleted ones are purged too). */
  apps: string[];
  /** Memberships that ended. */
  members: number;
}

type WorkspaceRef = Pick<WorkspaceSummary, 'id' | 'slug' | 'kind'>;

/** Soft-delete the live apps (hooks), then purge every app of the workspace → the slugs that were live. */
async function deleteWorkspaceApps(workspaceId: string, actor: { userId: string; kind: AuditActorKind }, opts: DeletionOptions) {
  const rows = await getDb()
    .select({ id: apps.id, slug: apps.slug, deletedAt: apps.deletedAt })
    .from(apps)
    .where(eq(apps.workspaceId, workspaceId))
    .orderBy(asc(apps.id));
  const live: string[] = [];
  for (const app of rows) {
    if (app.deletedAt) continue;
    try {
      await softDeleteApp(app.id, actor);
    } catch (err) {
      if (err instanceof AppsError && err.code === 'not_found') continue;
      throw err;
    }
    live.push(app.slug);
    await (opts.notify ?? notifyAppChanged)({ app_id: app.id, slug: app.slug, kind: 'delete' });
    try {
      await opts.hooks?.onAppDelete?.({ id: app.id, slug: app.slug, workspaceId });
    } catch (err) {
      logger.error('[tenancy] onAppDelete of a deleted workspace’s app failed', { err: dbErrorForLog(err) });
    }
  }
  const purged: string[] = [];
  for (const app of rows) {
    const out = await purgeApp(app.id, opts.disk ? { disk: opts.disk } : {});
    if (out) purged.push(out.appId);
  }
  if (purged.length > 0 && opts.hooks?.afterPurge) {
    try {
      await opts.hooks.afterPurge(purged);
    } catch (err) {
      logger.error('[tenancy] the clean-up after purging a deleted workspace’s apps failed', { err: dbErrorForLog(err) });
    }
  }
  return live;
}

/** The workspace row + its two audit rows, in the caller's transaction → the memberships that ended. */
async function deleteWorkspaceRow(
  tx: Tx,
  ws: WorkspaceRef,
  actor: { userId: string; kind: AuditActorKind },
  meta: { apps: number; withAccount: boolean },
  copyTo: string | null
): Promise<number> {
  const [members] = await tx.select({ n: count() }).from(memberships).where(eq(memberships.workspaceId, ws.id));
  await tx.delete(workspaces).where(eq(workspaces.id, ws.id));
  const entry = {
    actorUserId: actor.userId,
    actorKind: actor.kind,
    action: AUDIT_ACTIONS.workspaceDelete,
    subjectType: AUDIT_SUBJECT_TYPES.workspace,
    // A personal workspace's slug comes from its owner's e-mail address: not kept.
    target: ws.kind === 'team' ? ws.slug : null,
    meta: { apps: meta.apps, members: members?.n ?? 0, ...(meta.withAccount ? { with_account: true } : {}) },
  };
  await writeAudit({ workspaceId: ws.id, ...entry }, tx);
  if (copyTo) await writeAudit({ workspaceId: copyTo, ...entry }, tx);
  return members?.n ?? 0;
}

async function removeWorkspace(
  ws: WorkspaceRef,
  actor: { userId: string; kind: AuditActorKind },
  opts: DeletionOptions & { withAccount: boolean; copyTo: string | null }
): Promise<DeletedWorkspace> {
  const deletedApps: string[] = [];
  for (let attempt = 1; ; attempt += 1) {
    deletedApps.push(...(await deleteWorkspaceApps(ws.id, actor, opts)));
    try {
      const members = await getDb().transaction(async (tx) => {
        await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, ws.id)).for('update');
        return deleteWorkspaceRow(tx, ws, actor, { apps: deletedApps.length, withAccount: opts.withAccount }, opts.copyTo);
      });
      try {
        await dropWorkspaceInvites(ws.id);
      } catch (err) {
        logger.error('[tenancy] dropping a deleted workspace’s invites failed', { err: dbErrorForLog(err) });
      }
      return { slug: ws.slug, apps: deletedApps, members };
    } catch (err) {
      if (isForeignKeyViolation(err) && attempt < ROW_DELETE_ATTEMPTS) continue;
      throw err;
    }
  }
}

async function personalWorkspaceId(db: Executor, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: workspaces.id })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(and(eq(memberships.userId, userId), eq(memberships.role, 'workspace-admin'), eq(workspaces.kind, 'personal')))
    .limit(1);
  return row?.id ?? null;
}

/**
 * A workspace admin deletes a team workspace with everything in it (see the
 * file header). Refuses a personal workspace (`personal_workspace`) and an
 * actor below workspace-admin (`forbidden`); the caller checks the typed slug
 * or the user's confirmation first.
 */
export async function deleteWorkspace(
  input: { workspace: WorkspaceRef; actor: WorkspaceDeleteActor } & DeletionOptions
): Promise<DeletedWorkspace> {
  if (input.actor.role !== 'workspace-admin') {
    throw new DeletionError('forbidden', 'Deleting a workspace needs the workspace-admin role.');
  }
  if (input.workspace.kind === 'personal') throw new DeletionError('personal_workspace', PERSONAL);
  const personal = await personalWorkspaceId(getDb(), input.actor.userId);
  return removeWorkspace(input.workspace, input.actor, {
    ...input,
    withAccount: false,
    copyTo: personal !== input.workspace.id ? personal : null,
  });
}

/** Throws the refusal deleteWorkspace would answer, changing nothing. */
export function assertWorkspaceDeletable(input: { workspace: WorkspaceRef; actor: Pick<WorkspaceDeleteActor, 'role'> }): void {
  if (input.actor.role !== 'workspace-admin') {
    throw new DeletionError('forbidden', 'Deleting a workspace needs the workspace-admin role.');
  }
  if (input.workspace.kind === 'personal') throw new DeletionError('personal_workspace', PERSONAL);
}

// ── deleting an account ──────────────────────────────────────────────────────

export interface AccountWorkspace {
  slug: string;
  name: string;
  kind: 'personal' | 'team';
  /** The user's role in it. */
  role: WorkspaceRole;
  members: number;
  admins: number;
  /** Apps that are not deleted yet. */
  apps: number;
}

export interface AccountDeletionPlan {
  /** Deleted with the account: the personal workspace and every team workspace the user is the only member of. */
  deletes: AccountWorkspace[];
  /** Team workspaces the user leaves; the other members keep them. */
  leaves: AccountWorkspace[];
  /** Team workspaces that block the deletion: the user is their only workspace-admin and they have other members. */
  blockers: AccountWorkspace[];
}

type AccountWorkspaceRow = AccountWorkspace & { id: string };

async function accountWorkspaces(db: Executor, userId: string, opts: { lock?: boolean } = {}): Promise<AccountWorkspaceRow[]> {
  if (opts.lock) {
    await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(inArray(workspaces.id, db.select({ id: memberships.workspaceId }).from(memberships).where(eq(memberships.userId, userId))))
      .orderBy(asc(workspaces.id))
      .for('update');
  }
  return db
    .select({
      id: workspaces.id,
      slug: workspaces.slug,
      name: workspaces.name,
      kind: workspaces.kind,
      role: memberships.role,
      members: sql<number>`(select count(*)::int from memberships m where m.workspace_id = ${workspaces.id})`,
      admins: sql<number>`(select count(*)::int from memberships m where m.workspace_id = ${workspaces.id} and m.role = 'workspace-admin')`,
      apps: sql<number>`(select count(*)::int from apps a where a.workspace_id = ${workspaces.id} and a.deleted_at is null)`,
    })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(memberships.userId, userId))
    .orderBy(desc(sql`${workspaces.kind} = 'personal'`), asc(workspaces.createdAt), asc(workspaces.slug));
}

function fate(w: AccountWorkspace): keyof AccountDeletionPlan {
  if (w.kind === 'personal' || w.members <= 1) return 'deletes';
  if (w.role === 'workspace-admin' && w.admins <= 1) return 'blockers';
  return 'leaves';
}

function split(rows: AccountWorkspaceRow[]): Record<keyof AccountDeletionPlan, AccountWorkspaceRow[]> {
  const out: Record<keyof AccountDeletionPlan, AccountWorkspaceRow[]> = { deletes: [], leaves: [], blockers: [] };
  for (const w of rows) out[fate(w)].push(w);
  return out;
}

const publicView = (w: AccountWorkspaceRow): AccountWorkspace => ({
  slug: w.slug,
  name: w.name,
  kind: w.kind,
  role: w.role,
  members: w.members,
  admins: w.admins,
  apps: w.apps,
});

/** What deleting the account would do, for the confirmation page. */
export async function accountDeletionPlan(userId: string): Promise<AccountDeletionPlan> {
  const plan = split(await accountWorkspaces(getDb(), userId));
  return { deletes: plan.deletes.map(publicView), leaves: plan.leaves.map(publicView), blockers: plan.blockers.map(publicView) };
}

function soleAdminError(blockers: AccountWorkspace[]): DeletionError {
  const names = blockers.map((b) => `${b.name} (/${b.slug})`).join(', ');
  return new DeletionError(
    'sole_workspace_admin',
    `You are the only workspace-admin of ${names}, which other members still use. Make one of them a workspace-admin on the workspace’s Members tab, or delete the workspace, then delete your account.`,
    blockers.map((b) => ({ slug: b.slug, name: b.name, members: b.members }))
  );
}

export interface DeletedAccount {
  /** The workspaces deleted with the account. */
  deleted: DeletedWorkspace[];
  /** Slugs of the team workspaces the user left. */
  left: string[];
  /** Dashboard sessions that ended. */
  sessions: number;
}

/**
 * Delete the user's account (see the file header). The caller has verified
 * the user (a fresh e-mail code). Throws `sole_workspace_admin` while a team
 * workspace still needs them, and `workspaces_changed` when a membership
 * changed during the deletion in a way that needs a new look (nothing more
 * is deleted then; the user tries again).
 */
export async function deleteAccount(
  input: { userId: string; /** How a lease is taken (tests); Redis by default. */ takeLease?: TakeLeaseHeldBy } & DeletionOptions
): Promise<DeletedAccount> {
  const plan = split(await accountWorkspaces(getDb(), input.userId));
  if (plan.blockers.length > 0) throw soleAdminError(plan.blockers);
  const actor = { userId: input.userId, kind: 'user' as const };

  for (const w of plan.leaves) {
    try {
      await releaseUserAppLeases({ workspaceId: w.id, holderUserId: input.userId, actor, take: input.takeLease });
    } catch (err) {
      logger.error('[tenancy] releasing the app leases of a deleted account failed', { err: dbErrorForLog(err) });
    }
  }
  const deleted: DeletedWorkspace[] = [];
  for (const w of plan.deletes) {
    deleted.push(await removeWorkspace(w, actor, { ...input, withAccount: true, copyTo: null }));
  }

  const auditWorkspace =
    plan.deletes.find((w) => w.kind === 'personal')?.id ?? plan.deletes[0]?.id ?? plan.leaves[0]?.id ?? null;
  const lateDeletes: string[] = [];
  const left = await getDb().transaction(async (tx) => {
    // ensurePersonalWorkspace serializes on the users row: a page load meanwhile cannot add a workspace.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).for('update');
    const now = split(await accountWorkspaces(tx, input.userId, { lock: true }));
    if (now.blockers.length > 0) throw soleAdminError(now.blockers);
    for (const w of now.deletes) {
      // A workspace that appeared meanwhile (a page load created the personal one): gone with the account when empty.
      const [anyApp] = await tx.select({ id: apps.id }).from(apps).where(eq(apps.workspaceId, w.id)).limit(1);
      if (anyApp) {
        throw new DeletionError(
          'workspaces_changed',
          'Your workspaces changed while the account was being deleted. Open the page again to see what is left, then try again.'
        );
      }
      const members = await deleteWorkspaceRow(tx, w, actor, { apps: 0, withAccount: true }, null);
      deleted.push({ slug: w.slug, apps: [], members });
      lateDeletes.push(w.id);
    }
    for (const w of now.leaves) {
      await writeAudit(
        {
          workspaceId: w.id,
          actorUserId: input.userId,
          actorKind: 'user',
          action: AUDIT_ACTIONS.memberLeave,
          subjectType: AUDIT_SUBJECT_TYPES.member,
          target: input.userId,
          meta: { role: w.role, reason: 'account_deleted' },
        },
        tx
      );
    }
    const workspaceId = auditWorkspace ?? now.deletes[0]?.id ?? now.leaves[0]?.id;
    if (workspaceId) {
      await writeAudit(
        {
          workspaceId,
          actorUserId: input.userId,
          actorKind: 'user',
          action: AUDIT_ACTIONS.accountDelete,
          subjectType: AUDIT_SUBJECT_TYPES.account,
          target: input.userId,
          meta: { workspaces_deleted: deleted.length, workspaces_left: now.leaves.length },
        },
        tx
      );
    }
    // Memberships, API keys, OAuth codes and tokens go with the row; authored rows keep a null author.
    await tx.delete(users).where(eq(users.id, input.userId));
    return now.leaves.map((w) => w.slug);
  });

  for (const id of lateDeletes) {
    try {
      await dropWorkspaceInvites(id);
    } catch (err) {
      logger.error('[tenancy] dropping a deleted workspace’s invites failed', { err: dbErrorForLog(err) });
    }
  }
  let sessions = 0;
  try {
    sessions = await destroyUserSessions(input.userId);
  } catch (err) {
    logger.error('[tenancy] ending the sessions of a deleted account failed', { err: dbErrorForLog(err) });
  }
  return { deleted, left, sessions };
}
