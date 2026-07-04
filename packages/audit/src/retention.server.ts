/**
 * Audit RETENTION (PHY-85). The audit trail is append-only; the ONLY deletion
 * allowed anywhere in the system is this age-based prune, and it is NEVER exposed
 * over the API/UI (no route calls it — only the worker's periodic sweep + tests).
 * It deletes strictly by `created_at` age; it can never target a specific row.
 */
import { lt } from 'drizzle-orm';
import { auditLog, getDb } from '@drobek/db';

/** Generous default so nothing is lost before an operator opts into a shorter window. */
export const DEFAULT_AUDIT_RETENTION_DAYS = 365;

/** AUDIT_RETENTION_DAYS from env (positive integer), else the generous default. */
export function auditRetentionDays(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = (env.AUDIT_RETENTION_DAYS ?? '').trim();
  if (!raw) return DEFAULT_AUDIT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_AUDIT_RETENTION_DAYS;
  return Math.floor(n);
}

/** The cutoff instant: rows strictly OLDER than this are prunable. Pure. */
export function retentionCutoff(retentionDays: number, now: Date): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

export interface PruneAuditInput {
  retentionDays?: number;
  now?: Date;
}

/**
 * Delete audit rows older than the retention window. Returns the number pruned.
 * Age-only: there is no way to delete a specific row through this path.
 */
export async function pruneAuditLog(
  input: PruneAuditInput = {}
): Promise<{ deleted: number }> {
  const retentionDays = input.retentionDays ?? auditRetentionDays();
  const cutoff = retentionCutoff(retentionDays, input.now ?? new Date());
  const deleted = await getDb()
    .delete(auditLog)
    .where(lt(auditLog.createdAt, cutoff))
    .returning({ id: auditLog.id });
  return { deleted: deleted.length };
}
