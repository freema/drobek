/**
 * Invites — Redis-backed TTL tokens, NO invites table
 * (sessions + login codes are Redis too).
 *
 *   key    drobek:invite:<token>      token = randomBytes(32).toString('hex')
 *   value  JSON {id, workspaceId, role, email, invitedBy, createdAt}
 *   TTL    7 days
 *   use    single-use — GETDEL on accept
 *
 *   index  drobek:invites:<workspaceId>   hash  id → token
 *          the workspace's pending invites, for the Members tab's list and
 *          its Revoke; refreshed to the invite TTL on every create, entries
 *          of accepted, revoked or expired invites are dropped when listed.
 *          The id (16 hex) is what the dashboard shows and posts — never the token.
 *
 * Invites are TEAM-workspace-only (a personal workspace is single-user by
 * definition; this also keeps ensurePersonalWorkspace's "the personal
 * workspace you admin" invariant sound). Accept keeps the HIGHER role when
 * the user already has a membership. The optional email is delivery+display
 * metadata only — the link itself is the credential (link invites carry no
 * email at all), so accept is not restricted to the invited address.
 */
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { logger, maskEmail, normalizeAuthEmail, serializeError } from '@drobek/auth';
import { getRedis } from '@drobek/core';
import { getDb, memberships } from '@drobek/db';
import {
  writeAudit,
  actorKindForSurface,
  AUDIT_ACTIONS,
  AUDIT_SUBJECT_TYPES,
  type AuditActorKind,
} from '@drobek/audit';
import { sendInviteEmail } from './email/invite-email.server.js';
import { higherRole, isWorkspaceRole, type WorkspaceRole } from './roles.js';
import { getWorkspaceById } from './membership.server.js';

export const INVITE_TTL_SEC = 7 * 24 * 60 * 60; // 7 days

/** randomBytes(32).toString('hex') → exactly 64 lowercase hex chars. */
const INVITE_TOKEN_RE = /^[0-9a-f]{64}$/;

/** randomBytes(8).toString('hex') → exactly 16 lowercase hex chars. */
const INVITE_ID_RE = /^[0-9a-f]{16}$/;

export interface InviteRecord {
  /** Absent on invites created before the workspace index existed (they are not listed). */
  id?: string;
  workspaceId: string;
  role: WorkspaceRole;
  email: string | null;
  invitedBy: string;
  createdAt: string;
}

function inviteKey(token: string): string {
  return `drobek:invite:${token}`;
}

function inviteIndexKey(workspaceId: string): string {
  return `drobek:invites:${workspaceId}`;
}

export async function createInvite(args: {
  workspaceId: string;
  role: WorkspaceRole;
  invitedByUserId: string;
  email?: string | null;
}): Promise<{ token: string; id: string }> {
  if (!isWorkspaceRole(args.role)) {
    throw new Error('invalid invite role');
  }
  const token = randomBytes(32).toString('hex');
  const id = randomBytes(8).toString('hex');
  const record: InviteRecord = {
    id,
    workspaceId: args.workspaceId,
    role: args.role,
    email: args.email ?? null,
    invitedBy: args.invitedByUserId,
    createdAt: new Date().toISOString(),
  };
  const redis = getRedis();
  await redis.set(
    inviteKey(token),
    JSON.stringify(record),
    'EX',
    INVITE_TTL_SEC
  );
  await redis.hset(inviteIndexKey(args.workspaceId), id, token);
  await redis.expire(inviteIndexKey(args.workspaceId), INVITE_TTL_SEC);
  // NOTE: the member.invite audit row is written by inviteMember (it knows the
  // actor and the surface), NOT here — createInvite stays a pure Redis helper
  // (unit-tested without a database).
  return { token, id };
}

/**
 * Withdraw an invite nobody can have used yet: its link and its pending-list
 * entry go, unaudited (the invite never stood — revokeInvite is the admin's
 * audited withdrawal). A malformed token never builds a Redis key.
 */
export async function withdrawInvite(token: string): Promise<void> {
  if (!INVITE_TOKEN_RE.test(token)) return;
  const redis = getRedis();
  const invite = parseInvite(await redis.getdel(inviteKey(token)));
  if (invite?.id) await redis.hdel(inviteIndexKey(invite.workspaceId), invite.id);
}

/**
 * Write the member.invite governance row. The actor is the inviting user;
 * the surface decides actor_kind (`web` = the dashboard → user, `mcp` = their
 * agent's invite_member → agent). The invited EMAIL is PII and is
 * deliberately NOT stored — only the granted role, which is non-sensitive;
 * there is no member user id yet, so the subject id is null.
 */
async function auditMemberInvite(args: {
  workspaceId: string;
  invitedByUserId: string;
  role: WorkspaceRole;
  surface?: 'web' | 'mcp';
}): Promise<void> {
  await writeAudit({
    workspaceId: args.workspaceId,
    actorUserId: args.invitedByUserId,
    actorKind: actorKindForSurface(args.surface ?? 'web'),
    action: AUDIT_ACTIONS.memberInvite,
    subjectType: AUDIT_SUBJECT_TYPES.member,
    target: null,
    meta: { role: args.role },
  });
}

const INVITE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_EMAIL_MAX = 254;

/** The invited address, normalized like a sign-in address — or null when it does not look like one (≤ 254 characters). */
export function normalizeInviteEmail(raw: string): string | null {
  const email = normalizeAuthEmail(raw.trim());
  return INVITE_EMAIL_RE.test(email) && email.length <= INVITE_EMAIL_MAX ? email : null;
}

/** The side effects of an invite: the Redis token, its withdrawal and the e-mail (injectable for tests). */
export interface MemberInviteDeps {
  create: typeof createInvite;
  withdraw: (token: string) => Promise<void>;
  send: (args: { email: string; workspaceName: string; role: WorkspaceRole; acceptUrl: string }) => Promise<void>;
}

export function defaultMemberInviteDeps(): MemberInviteDeps {
  return { create: createInvite, withdraw: withdrawInvite, send: sendInviteEmail };
}

export type InviteMemberResult =
  | { ok: true; role: WorkspaceRole; email: string | null; inviteUrl: string; emailSent: boolean }
  | { ok: false; reason: 'not-team' | 'invalid-role' | 'invalid-email' | 'email-failed'; message: string };

/**
 * A workspace admin invites someone — the ONE invite flow of the dashboard's
 * /workspaces/:slug/invite and the MCP tool invite_member (the caller has
 * checked the workspace-admin role). Team workspaces only; the role is one
 * of the three; the optional e-mail is normalized and must look like an
 * address (≤ 254 characters). The invite e-mail goes out when an address is
 * given; a send failure is logged and the link stays valid — unless
 * `requireDelivery` (MCP: the link never passes through the agent, so an
 * invite nobody received is withdrawn and nothing is audited). The
 * member.invite row is written once the invite stands.
 */
export async function inviteMember(input: {
  workspace: { id: string; name: string; kind: string };
  invitedByUserId: string;
  role: string;
  email: string | null;
  surface: 'web' | 'mcp';
  requireDelivery?: boolean;
  deps?: MemberInviteDeps;
  env?: NodeJS.ProcessEnv;
}): Promise<InviteMemberResult> {
  if (input.workspace.kind !== 'team') {
    return { ok: false, reason: 'not-team', message: 'Invites are only available for team workspaces.' };
  }
  const role = input.role;
  if (!isWorkspaceRole(role)) return { ok: false, reason: 'invalid-role', message: 'Pick a valid role.' };
  const raw = (input.email ?? '').trim();
  let email: string | null = null;
  if (raw) {
    email = normalizeInviteEmail(raw);
    if (!email) return { ok: false, reason: 'invalid-email', message: 'Enter a valid email address.' };
  } else if (input.requireDelivery) {
    return { ok: false, reason: 'invalid-email', message: 'Enter the email address to send the invite to.' };
  }

  const deps = input.deps ?? defaultMemberInviteDeps();
  const { token } = await deps.create({ workspaceId: input.workspace.id, role, invitedByUserId: input.invitedByUserId, email });
  const inviteUrl = acceptInviteUrl(token, input.env);

  let emailSent = false;
  if (email) {
    try {
      await deps.send({ email, workspaceName: input.workspace.name, role, acceptUrl: inviteUrl });
      emailSent = true;
    } catch (err) {
      logger.error('[tenancy] sendInviteEmail failed', { err: serializeError(err), email: maskEmail(email) });
    }
  }
  if (input.requireDelivery && !emailSent) {
    await deps.withdraw(token);
    return { ok: false, reason: 'email-failed', message: 'The invite email could not be sent, so the invite was withdrawn.' };
  }

  await auditMemberInvite({ workspaceId: input.workspace.id, invitedByUserId: input.invitedByUserId, role, surface: input.surface });
  return { ok: true, role, email, inviteUrl, emailSent };
}

function parseInvite(raw: string | null): InviteRecord | null {
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as InviteRecord;
    if (!rec.workspaceId || !isWorkspaceRole(rec.role)) return null;
    return rec;
  } catch {
    return null;
  }
}

/** Peek without consuming (the GET /invite/:token view must not burn it). */
export async function getInvite(token: string): Promise<InviteRecord | null> {
  // Never build Redis keys from arbitrary URL params.
  if (!INVITE_TOKEN_RE.test(token)) return null;
  return parseInvite(await getRedis().get(inviteKey(token)));
}

/** Single-use consumption — GETDEL, atomically gone after the first accept. */
export async function consumeInvite(
  token: string
): Promise<InviteRecord | null> {
  if (!INVITE_TOKEN_RE.test(token)) return null;
  const redis = getRedis();
  const invite = parseInvite(await redis.getdel(inviteKey(token)));
  if (invite?.id) await redis.hdel(inviteIndexKey(invite.workspaceId), invite.id);
  return invite;
}

/** A pending invite as the Members tab lists it (never its token). */
export interface PendingInvite {
  id: string;
  role: WorkspaceRole;
  email: string | null;
  /** The inviting user's id. */
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
}

function pendingInvite(id: string, invite: InviteRecord): PendingInvite {
  return {
    id,
    role: invite.role,
    email: invite.email,
    invitedBy: invite.invitedBy,
    createdAt: invite.createdAt,
    expiresAt: new Date(Date.parse(invite.createdAt) + INVITE_TTL_SEC * 1000).toISOString(),
  };
}

/** The workspace's invites that can still be accepted, newest first. */
export async function listPendingInvites(workspaceId: string): Promise<PendingInvite[]> {
  const redis = getRedis();
  const index = await redis.hgetall(inviteIndexKey(workspaceId));
  const ids = Object.keys(index);
  if (ids.length === 0) return [];
  const values = await redis.mget(...ids.map((id) => inviteKey(index[id]!)));
  const out: PendingInvite[] = [];
  const stale: string[] = [];
  ids.forEach((id, i) => {
    const invite = parseInvite(values[i] ?? null);
    if (!invite || invite.id !== id || invite.workspaceId !== workspaceId) {
      stale.push(id);
      return;
    }
    out.push(pendingInvite(id, invite));
  });
  if (stale.length > 0) await redis.hdel(inviteIndexKey(workspaceId), ...stale);
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Revoke a pending invite of the workspace: its link stops working at once
 * (GETDEL — an accept racing it gets the invite or nothing, never both).
 * Audited `member.invite_revoke` with the role only, never the address.
 * Null when there is no such pending invite (accepted, expired or revoked).
 */
export async function revokeInvite(args: {
  workspaceId: string;
  inviteId: string;
  actor: { userId: string; kind: AuditActorKind };
}): Promise<PendingInvite | null> {
  if (!INVITE_ID_RE.test(args.inviteId)) return null;
  const redis = getRedis();
  const token = await redis.hget(inviteIndexKey(args.workspaceId), args.inviteId);
  if (token === null || !INVITE_TOKEN_RE.test(token)) return null;
  const invite = parseInvite(await redis.getdel(inviteKey(token)));
  await redis.hdel(inviteIndexKey(args.workspaceId), args.inviteId);
  if (!invite || invite.workspaceId !== args.workspaceId) return null;
  await writeAudit({
    workspaceId: args.workspaceId,
    actorUserId: args.actor.userId,
    actorKind: args.actor.kind,
    action: AUDIT_ACTIONS.memberInviteRevoke,
    subjectType: AUDIT_SUBJECT_TYPES.member,
    target: null,
    meta: { role: invite.role },
  });
  return pendingInvite(args.inviteId, invite);
}

/**
 * Drop every pending invite of a workspace that is being deleted: their links
 * stop working at once → how many were removed. Not audited (the
 * `workspace.delete` row covers it).
 */
export async function dropWorkspaceInvites(workspaceId: string): Promise<number> {
  const redis = getRedis();
  const index = await redis.hgetall(inviteIndexKey(workspaceId));
  const tokens = Object.values(index).filter((t) => INVITE_TOKEN_RE.test(t));
  const removed = tokens.length > 0 ? await redis.del(...tokens.map(inviteKey)) : 0;
  await redis.del(inviteIndexKey(workspaceId));
  return removed;
}

/** Accept keeps the HIGHER of (existing membership role, invited role). */
export function resolveAcceptedRole(
  existing: WorkspaceRole | null,
  invited: WorkspaceRole
): WorkspaceRole {
  return existing === null ? invited : higherRole(existing, invited);
}

export type AcceptInviteResult =
  | { ok: true; workspaceId: string; workspaceSlug: string; role: WorkspaceRole }
  | { ok: false };

export async function acceptInvite(args: {
  token: string;
  userId: string;
}): Promise<AcceptInviteResult> {
  const invite = await consumeInvite(args.token);
  if (!invite) return { ok: false };

  const workspace = await getWorkspaceById(invite.workspaceId);
  if (!workspace) return { ok: false };

  const db = getDb();
  const existingRows = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, args.userId),
        eq(memberships.workspaceId, invite.workspaceId)
      )
    )
    .limit(1);
  const existing = existingRows[0]?.role ?? null;
  const finalRole = resolveAcceptedRole(existing, invite.role);

  // The membership write + its governance audit go in ONE transaction so
  // the row and its provenance land together. The actor is the ACCEPTING user
  // (server-derived from the session at the route) and the surface is 'web'
  // (an invite is accepted only in the dashboard) → actor_kind = user. The subject is the member's
  // own stable user id (an opaque cuid, not PII); the invited email is never stored.
  await db.transaction(async (tx) => {
    if (existing === null) {
      await tx
        .insert(memberships)
        .values({
          userId: args.userId,
          workspaceId: invite.workspaceId,
          role: finalRole,
        })
        .onConflictDoNothing();
      await writeAudit(
        {
          workspaceId: invite.workspaceId,
          actorUserId: args.userId,
          actorKind: actorKindForSurface('web'),
          action: AUDIT_ACTIONS.memberAccept,
          subjectType: AUDIT_SUBJECT_TYPES.member,
          target: args.userId,
          meta: { role: finalRole },
        },
        tx
      );
    } else if (existing !== finalRole) {
      // Accept UPGRADED an existing membership — the one role-change path that
      // exists today (a dedicated role-edit UI is deferred; the action enum stays
      // open for it). Recorded as member.role_change.
      await tx
        .update(memberships)
        .set({ role: finalRole })
        .where(
          and(
            eq(memberships.userId, args.userId),
            eq(memberships.workspaceId, invite.workspaceId)
          )
        );
      await writeAudit(
        {
          workspaceId: invite.workspaceId,
          actorUserId: args.userId,
          actorKind: actorKindForSurface('web'),
          action: AUDIT_ACTIONS.memberRoleChange,
          subjectType: AUDIT_SUBJECT_TYPES.member,
          target: args.userId,
          meta: { from: existing, to: finalRole },
        },
        tx
      );
    } else {
      // Already a member at an equal-or-higher role: the invite was consumed but
      // no role changed. The accept still happened — record it.
      await writeAudit(
        {
          workspaceId: invite.workspaceId,
          actorUserId: args.userId,
          actorKind: actorKindForSurface('web'),
          action: AUDIT_ACTIONS.memberAccept,
          subjectType: AUDIT_SUBJECT_TYPES.member,
          target: args.userId,
          meta: { role: finalRole },
        },
        tx
      );
    }
  });

  return {
    ok: true,
    workspaceId: invite.workspaceId,
    workspaceSlug: workspace.slug,
    role: finalRole,
  };
}

/** PUBLIC_ORIGIN (else PUBLIC_APP_URL) + /invite/<token>. */
export function acceptInviteUrl(
  token: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const origin = (env.PUBLIC_ORIGIN?.trim() || env.PUBLIC_APP_URL?.trim() || 'http://localhost:3041').replace(/\/+$/, '');
  return `${origin}/invite/${token}`;
}
