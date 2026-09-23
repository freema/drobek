import { startBlobGc } from '@drobek/apps';
import { auditRetentionDays, pruneAuditLog } from '@drobek/audit';
import type { Logger } from '@drobek/core';

const AUDIT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface BackgroundJobs {
  stop(): Promise<void>;
}

/**
 * In-process background work — there is no separate worker container.
 *
 * - Blob GC (hourly, one replica at a time via a Redis lease): deletes blobs
 *   no version references, after a 7-day grace period.
 * - PHY-85 governance: the audit trail is append-only; the ONLY deletion is
 *   the age-based retention prune (startup, then daily). It never targets a
 *   specific row and is not exposed over any API/UI.
 */
export function startBackgroundJobs(log: Logger): BackgroundJobs {
  const stopBlobGc = startBlobGc((msg, err) =>
    err ? log.error(msg, { error: (err as Error).message }) : log.info(msg)
  );

  const pruneAuditOnce = async (): Promise<void> => {
    try {
      const { deleted } = await pruneAuditLog();
      if (deleted > 0) {
        log.info('audit retention prune', { deleted, retentionDays: auditRetentionDays() });
      }
    } catch (err) {
      log.error('audit retention prune failed', { error: (err as Error).message });
    }
  };
  void pruneAuditOnce();
  const timer = setInterval(() => void pruneAuditOnce(), AUDIT_PRUNE_INTERVAL_MS);
  timer.unref();

  return {
    async stop() {
      clearInterval(timer);
      stopBlobGc();
    },
  };
}
