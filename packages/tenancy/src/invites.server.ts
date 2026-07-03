/**
 * Invites (U4, PHY-54) — Redis-backed TTL tokens, NO invites table (ratified
 * pattern: sessions + login codes are Redis too).
 *
 *   key    drobek:invite:<token>      token = randomBytes(32).toString('hex')
 *   value  JSON {workspaceId, role, email, invitedBy, createdAt}
 *   TTL    7 days
 *   use    single-use — GETDEL on accept
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
import { getRedis } from '@drobek/core';
import { getDb, memberships } from '@drobek/db';
import { higherRole, isWorkspaceRole, type WorkspaceRole } from './roles.js';
import { getWorkspaceById } from './membership.server.js';

export const INVITE_TTL_SEC = 7 * 24 * 60 * 60; // 7 days

/** randomBytes(32).toString('hex') → exactly 64 lowercase hex chars. */
const INVITE_TOKEN_RE = /^[0-9a-f]{64}$/;

export interface InviteRecord {
  workspaceId: string;
  role: WorkspaceRole;
  email: string | null;
  invitedBy: string;
  createdAt: string;
}

function inviteKey(token: string): string {
  return `drobek:invite:${token}`;
}

export async function createInvite(args: {
  workspaceId: string;
  role: WorkspaceRole;
  invitedByUserId: string;
  email?: string | null;
}): Promise<{ token: string }> {
  if (!isWorkspaceRole(args.role)) {
    throw new Error('invalid invite role');
  }
  const token = randomBytes(32).toString('hex');
  const record: InviteRecord = {
    workspaceId: args.workspaceId,
    role: args.role,
    email: args.email ?? null,
    invitedBy: args.invitedByUserId,
    createdAt: new Date().toISOString(),
  };
  await getRedis().set(
    inviteKey(token),
    JSON.stringify(record),
    'EX',
    INVITE_TTL_SEC
  );
  return { token };
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
  return parseInvite(await getRedis().getdel(inviteKey(token)));
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

  if (existing === null) {
    await db
      .insert(memberships)
      .values({
        userId: args.userId,
        workspaceId: invite.workspaceId,
        role: finalRole,
      })
      .onConflictDoNothing();
  } else if (existing !== finalRole) {
    await db
      .update(memberships)
      .set({ role: finalRole })
      .where(
        and(
          eq(memberships.userId, args.userId),
          eq(memberships.workspaceId, invite.workspaceId)
        )
      );
  }

  return {
    ok: true,
    workspaceId: invite.workspaceId,
    workspaceSlug: workspace.slug,
    role: finalRole,
  };
}

/** PUBLIC_ORIGIN + /invite/<token> (same env default as the auth package). */
export function acceptInviteUrl(
  token: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const origin = ((env.PUBLIC_ORIGIN ?? '').trim() || 'http://localhost:3041')
    .replace(/\/+$/, '');
  return `${origin}/invite/${token}`;
}
