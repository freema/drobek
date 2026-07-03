/**
 * drobek deploy worker (U6, PHY-57). Runs INSIDE the web image as the
 * drobek-worker container (`node scripts/worker.mjs`, WORKDIR .../apps/web),
 * sharing the DB, redis and the drobek_blobs volume with web+mcp. It is a plain
 * BullMQ consumer — no HTTP server — for the "deploys" queue (prefix "drobek").
 * Both editions (selfhost core + saas) run this exact file.
 */
import { createConsoleLogger } from '@drobek/core';
import { DEPLOY_QUEUE, QUEUE_PREFIX, createDeployWorker } from '@drobek/deploy';

const log = createConsoleLogger('drobek-worker');
log.info('starting deploy worker', { queue: DEPLOY_QUEUE, prefix: QUEUE_PREFIX });

const worker = createDeployWorker();

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
  try {
    await worker.close();
  } catch (err) {
    log.error('shutdown error', { error: err?.message });
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
