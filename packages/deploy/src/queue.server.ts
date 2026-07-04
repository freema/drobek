/**
 * BullMQ wiring (U6, PHY-57). The queue runs on the SHARED redis, so:
 *  - it MUST carry the `drobek` PREFIX (BullMQ key prefix — NOT ioredis
 *    keyPrefix) to avoid colliding with puls' queues, and
 *  - its ioredis connection MUST set `maxRetriesPerRequest: null` (a BullMQ
 *    hard requirement for blocking commands).
 */
import { Queue, type ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { type AuditActorKind } from './audit.server.js';
import { DEPLOY_QUEUE, QUEUE_PREFIX } from './constants.js';

/** Governance attribution carried on the deploy job (PHY-85). */
export interface DeployJobActor {
  actorUserId: string;
  actorKind: AuditActorKind;
}

function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is required');
  return url;
}

/**
 * A dedicated BullMQ ioredis connection (never the shared @drobek/core one),
 * with `maxRetriesPerRequest: null` as BullMQ requires. Typed as BullMQ's
 * ConnectionOptions — bullmq bundles its own (duplicate) ioredis copy, so the
 * live 5.x instance is passed through structurally.
 */
export function createBullConnection(): ConnectionOptions {
  return new Redis(requireRedisUrl(), {
    maxRetriesPerRequest: null,
  }) as unknown as ConnectionOptions;
}

let queue: Queue | null = null;
export function getDeployQueue(): Queue {
  if (!queue) {
    queue = new Queue(DEPLOY_QUEUE, {
      connection: createBullConnection(),
      prefix: QUEUE_PREFIX,
    });
  }
  return queue;
}

/**
 * Enqueue a deploy job. `jobId = deployId` makes the enqueue idempotent per
 * deploy (a duplicate commit of the same deploy will not fan out extra jobs
 * while one is still pending). Retries cover transient worker/lock failures.
 */
export async function enqueueDeploy(
  deployId: string,
  actor?: DeployJobActor
): Promise<void> {
  await getDeployQueue().add(
    'process',
    {
      deployId,
      actorUserId: actor?.actorUserId ?? null,
      actorKind: actor?.actorKind ?? null,
    },
    {
      jobId: deployId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 200,
      removeOnFail: 500,
    }
  );
}

/** Close the shared queue connection (graceful shutdown / tests). */
export async function closeDeployQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
}
