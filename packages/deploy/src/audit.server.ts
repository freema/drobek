/**
 * Append-only audit writes (U6, PHY-57). Never logs secrets; `meta` carries
 * structured, non-sensitive context only.
 */
import { auditLog, getDb } from '@drobek/db';

export interface AuditEntry {
  workspaceId: string;
  actorUserId?: string | null;
  action: string;
  target?: string | null;
  meta?: Record<string, unknown> | null;
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
  await getDb()
    .insert(auditLog)
    .values({
      workspaceId: entry.workspaceId,
      actorUserId: entry.actorUserId ?? null,
      action: entry.action,
      target: entry.target ?? null,
      meta: entry.meta ?? null,
    });
}
