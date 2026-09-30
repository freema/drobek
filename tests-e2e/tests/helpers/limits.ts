import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';

/**
 * The fake limits provider: both composes point LIMITS_PROVIDER_URL
 * at proxy-echo, which answers a workspace's plan from
 * tests-e2e/.limits-provider/<workspace_id>.json (bind-mounted), else `{}`.
 * drobek caches an answer 60 s in Redis (`drobek:limits:<workspace_id>`), so a
 * change drops that key too.
 */
const PLANS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.limits-provider');

export async function setFakePlan(workspaceId: string, plan: Record<string, number> | null): Promise<void> {
  const file = join(PLANS, `${workspaceId}.json`);
  if (plan === null) rmSync(file, { force: true });
  else {
    mkdirSync(PLANS, { recursive: true });
    writeFileSync(file, JSON.stringify(plan));
  }
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6391', { maxRetriesPerRequest: 2, lazyConnect: true });
  await redis.connect();
  try {
    await redis.del(`drobek:limits:${workspaceId}`);
  } finally {
    redis.disconnect();
  }
}
