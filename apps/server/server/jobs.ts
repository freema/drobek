import { startBlobGc, startSlugRelease } from '@drobek/apps';
import { auditRetentionDays, pruneAuditLog } from '@drobek/audit';
import type { Logger } from '@drobek/core';
import { startDomainRecheck } from '@drobek/domains';

const AUDIT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface BackgroundJobs {
  stop(): Promise<void>;
}

/**
 * In-process background work — there is no separate worker container.
 *
 * - Blob GC (hourly, one replica at a time via a Redis lease): deletes blobs
 *   no version references, after a 7-day grace period.
 * - Slug release (hourly, Redis lease; NSO-288): a soft-deleted app's slug is
 *   free again 30 days after the delete (renamed to its tombstone).
 * - M3-01 custom domains: the DNS re-check (hourly sweep, Redis lease) of every
 *   verified domain last checked 24 h+ ago — records gone → unverified + one
 *   e-mail to the app's owners.
 * - PHY-85 governance: the audit trail is append-only; the ONLY deletion is
 *   the age-based retention prune (startup, then daily). It never targets a
 *   specific row and is not exposed over any API/UI.
 */
export function startBackgroundJobs(log: Logger): BackgroundJobs {
  const jobLog = (msg: string, err?: unknown) =>
    err ? log.error(msg, { error: (err as Error).message }) : log.info(msg);
  const stopBlobGc = startBlobGc(jobLog);
  const stopSlugRelease = startSlugRelease(jobLog);

  const stopDomainRecheck = startDomainRecheck((msg, meta, err) =>
    err ? log.error(msg, { ...meta, error: (err as Error).message }) : log.info(msg, meta)
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
      stopSlugRelease();
      stopDomainRecheck();
    },
  };
}
