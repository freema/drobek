import type { Logger } from '@drobek/core';
import { auditRetentionDays, createDeployWorker, pruneAuditLog } from '@drobek/deploy';

const AUDIT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface BackgroundJobs {
  stop(): Promise<void>;
}

/**
 * In-process background work — there is no separate worker container.
 *
 * - The legacy deploy consumer keeps the upload pipeline working until M0-02
 *   removes it (and this call) together with `@drobek/deploy`.
 * - PHY-85 governance: the audit trail is append-only; the ONLY deletion is
 *   this age-based retention prune (startup, then daily). It never targets a
 *   specific row and is not exposed over any API/UI.
 */
export function startBackgroundJobs(log: Logger): BackgroundJobs {
  const worker = createDeployWorker();
  worker.on('failed', (job, err) =>
    log.error('deploy job failed', {
      jobId: job?.id,
      deployId: (job?.data as { deployId?: string } | undefined)?.deployId,
      error: err?.message,
    })
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
      await worker.close();
    },
  };
}
