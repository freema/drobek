/**
 * Audit READ for the workspace Activity view (PHY-85). Reads are strictly
 * workspace-scoped (the caller MUST pass a workspaceId it has already authorized
 * — the dashboard loader gates on workspace-admin/super-admin BEFORE calling).
 *
 * Newest-first keyset pagination on (created_at, id) so the page is stable even
 * as new rows arrive. The actor email is LEFT-joined for display only (never
 * stored in the row); the subject is plain text with no join to `apps`, so
 * events for a DELETED / tombstoned app still list.
 */
import { and, desc, eq, lt, or } from 'drizzle-orm';
import { auditLog, getDb, users } from '@drobek/db';
import type { AuditActorKind } from './actor.js';

export interface AuditRow {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  actorKind: AuditActorKind;
  action: string;
  subjectType: string | null;
  target: string | null;
  meta: unknown;
  createdAt: Date;
}

export interface ListActivityInput {
  workspaceId: string;
  /** Exact action filter (e.g. 'deploy.rollback'), optional. */
  action?: string | null;
  /** Exact subject filter — the app slug, optional. */
  subject?: string | null;
  /** Page size (rows returned); one extra row is probed for nextCursor. */
  limit?: number;
  /** Opaque keyset cursor from a prior page. */
  cursor?: string | null;
}

export interface ListActivityResult {
  rows: AuditRow[];
  nextCursor: string | null;
}

interface Keyset {
  t: string;
  i: string;
}

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  const ks: Keyset = { t: row.createdAt.toISOString(), i: row.id };
  return Buffer.from(JSON.stringify(ks), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null | undefined): Keyset | null {
  if (!cursor) return null;
  try {
    const ks = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8')
    ) as Keyset;
    if (typeof ks.t !== 'string' || typeof ks.i !== 'string') return null;
    if (Number.isNaN(new Date(ks.t).getTime())) return null;
    return ks;
  } catch {
    return null;
  }
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

/** Build the AND-combined where for a workspace + optional filters + keyset. */
function buildWhere(input: ListActivityInput) {
  const conds = [eq(auditLog.workspaceId, input.workspaceId)];
  if (input.action) conds.push(eq(auditLog.action, input.action));
  if (input.subject) conds.push(eq(auditLog.target, input.subject));

  const ks = decodeCursor(input.cursor);
  if (ks) {
    const boundary = new Date(ks.t);
    // (created_at, id) < (t, i) — the newest-first keyset boundary.
    conds.push(
      or(
        lt(auditLog.createdAt, boundary),
        and(eq(auditLog.createdAt, boundary), lt(auditLog.id, ks.i))
      )!
    );
  }
  return and(...conds);
}

export async function listActivity(
  input: ListActivityInput
): Promise<ListActivityResult> {
  const limit = clampLimit(input.limit);
  const rows = await getDb()
    .select({
      id: auditLog.id,
      actorUserId: auditLog.actorUserId,
      actorEmail: users.email,
      actorKind: auditLog.actorKind,
      action: auditLog.action,
      subjectType: auditLog.subjectType,
      target: auditLog.target,
      meta: auditLog.meta,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(buildWhere(input))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit + 1);

  let nextCursor: string | null = null;
  if (rows.length > limit) {
    const last = rows[limit - 1];
    nextCursor = encodeCursor({ createdAt: last.createdAt, id: last.id });
    rows.length = limit;
  }

  return {
    rows: rows.map((r) => ({
      id: r.id,
      actorUserId: r.actorUserId,
      actorEmail: r.actorEmail ?? null,
      actorKind: r.actorKind as AuditActorKind,
      action: r.action,
      subjectType: r.subjectType,
      target: r.target,
      meta: r.meta,
      createdAt: r.createdAt,
    })),
    nextCursor,
  };
}
