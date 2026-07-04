/**
 * Append-only audit WRITE (PHY-85; extracted from @drobek/deploy so both
 * @drobek/deploy and @drobek/tenancy can write without a dependency cycle — this
 * package depends ONLY on @drobek/db).
 *
 * The ONLY mutation this module performs is an INSERT. There is deliberately no
 * update/delete path here (retention prune lives in ./retention.server.ts and is
 * the sole, age-only deletion). `actor_kind` is REQUIRED and must be resolved
 * server-side (see ./actor.ts) — never taken from client input. `meta` must
 * carry NO secrets and NO PII.
 */
import { auditLog, getDb, type DB } from '@drobek/db';
import type { AuditActorKind } from './actor.js';

/** A transaction handle or the base db — lets a caller write in-txn with the action. */
export type AuditExecutor =
  | DB
  | Parameters<Parameters<DB['transaction']>[0]>[0];

export interface AuditEntry {
  workspaceId: string;
  /** The acting user; null only for genuine system actions. */
  actorUserId?: string | null;
  /** agent (MCP tool) vs user (dashboard/web) — server-derived. */
  actorKind: AuditActorKind;
  action: string;
  /** The kind of subject: 'app' | 'member' | … */
  subjectType?: string | null;
  /** The subject's STABLE id (app slug, member user id, …) — stored as text. */
  target?: string | null;
  /** Structured, secret-free + PII-free context only. */
  meta?: Record<string, unknown> | null;
}

/**
 * Append one immutable audit row. Pass `executor` (a drizzle tx) to write inside
 * the same transaction as the mutation being audited.
 */
export async function writeAudit(
  entry: AuditEntry,
  executor?: AuditExecutor
): Promise<void> {
  const db = executor ?? getDb();
  await db.insert(auditLog).values({
    workspaceId: entry.workspaceId,
    actorUserId: entry.actorUserId ?? null,
    actorKind: entry.actorKind,
    action: entry.action,
    subjectType: entry.subjectType ?? null,
    target: entry.target ?? null,
    meta: entry.meta ?? null,
  });
}
