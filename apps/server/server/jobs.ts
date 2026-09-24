import { startBlobGc, startSlugRelease, withRedisLock } from '@drobek/apps';
import { auditRetentionDays, pruneAuditLog } from '@drobek/audit';
import type { Logger } from '@drobek/core';
import { startDomainRecheck } from '@drobek/domains';
import { startLogsPrune } from '@drobek/insights';
import { startFilesSweep } from 'drobek-module-files';

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
 * - NSO-325 files sweep (only when the `files` module is active;
 *   FILES_SWEEP_INTERVAL_MS, Redis lease): the uploads of apps deleted
 *   FILES_SWEEP_RETENTION_MS ago, blobs no `mod_files` row references and
 *   stale temp uploads (logic in drobek-module-files).
 * - NSO-327 get_logs retention prune (LOGS_PRUNE_INTERVAL_MS, Redis lease):
 *   browser errors, compiles and daily request stats older than their
 *   retention (30 days) and errors past the newest 500 per app, for every app
 *   (logic in @drobek/insights).
 * - PHY-85 governance: the audit trail is append-only; the ONLY deletion is
 *   the age-based retention prune (startup, then daily). It never targets a
 *   specific row and is not exposed over any API/UI.
 */
export function startBackgroundJobs(log: Logger, opts: { filesSweep?: boolean } = {}): BackgroundJobs {
  const jobLog = (msg: string, err?: unknown) =>
    err ? log.error(msg, { error: (err as Error).message }) : log.info(msg);
  const stopBlobGc = startBlobGc(jobLog);
  const stopSlugRelease = startSlugRelease(jobLog);
  const stopFilesSweep = opts.filesSweep ? startFilesSweep({ log: jobLog, lease: withRedisLock }) : () => {};
  const stopLogsPrune = startLogsPrune({ log: jobLog, lease: withRedisLock });

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
      stopFilesSweep();
      stopLogsPrune();
      stopDomainRecheck();
    },
  };
}
