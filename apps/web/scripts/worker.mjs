/**
 * drobek deploy worker (U6, PHY-57). Runs INSIDE the web image as the
 * drobek-worker container (`node scripts/worker.mjs`, WORKDIR .../apps/web),
 * sharing the DB, redis and the drobek_blobs volume with web+mcp. It is a plain
 * BullMQ consumer — no HTTP server — for the "deploys" queue (prefix "drobek").
 * Both editions (selfhost core + saas) run this exact file.
 */
import { createConsoleLogger } from '@drobek/core';
import {
  DEPLOY_QUEUE,
  QUEUE_PREFIX,
  auditRetentionDays,
  createDeployWorker,
  pruneAuditLog,
} from '@drobek/deploy';

const log = createConsoleLogger('drobek-worker');
log.info('starting deploy worker', { queue: DEPLOY_QUEUE, prefix: QUEUE_PREFIX });

const worker = createDeployWorker();

// PHY-85 governance: the audit trail is append-only; the ONLY deletion anywhere
// is this age-based retention prune, driven from the worker's periodic sweep (it
// never targets a specific row and is not exposed over any API/UI). Runs at
// startup, then daily; a failure is logged and retried on the next tick.
const AUDIT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
async function pruneAuditOnce() {
  try {
    const { deleted } = await pruneAuditLog();
    if (deleted > 0) {
      log.info('audit retention prune', {
        deleted,
        retentionDays: auditRetentionDays(),
      });
    }
  } catch (err) {
    log.error('audit retention prune failed', { error: err?.message });
  }
}
void pruneAuditOnce();
const auditPruneTimer = setInterval(
  () => void pruneAuditOnce(),
  AUDIT_PRUNE_INTERVAL_MS
);
if (typeof auditPruneTimer.unref === 'function') auditPruneTimer.unref();

worker.on('ready', () => log.info('worker ready'));
worker.on('active', (job) =>
  log.info('job active', { jobId: job.id, deployId: job.data?.deployId })
);
worker.on('completed', (job) =>
  log.info('job completed', { jobId: job.id, deployId: job.data?.deployId })
);
worker.on('failed', (job, err) =>
  log.error('job failed', {
    jobId: job?.id,
    deployId: job?.data?.deployId,
    error: err?.message,
  })
);
worker.on('error', (err) => log.error('worker error', { error: err?.message }));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal });
  clearInterval(auditPruneTimer);
  try {
    await worker.close();
  } catch (err) {
    log.error('shutdown error', { error: err?.message });
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
