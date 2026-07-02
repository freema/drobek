import { Redis } from 'ioredis';

let client: Redis | null = null;

function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL is required');
  }
  return url;
}

/** Lazy shared ioredis client. Fails fast so /healthz can flip to 503. */
export function getRedis(): Redis {
  if (!client) {
    client = new Redis(requireRedisUrl(), { maxRetriesPerRequest: 2 });
  }
  return client;
}

/** Cheap connectivity probe used by runHealthChecks(). */
export async function healthRedisPing(): Promise<void> {
  const pong = await getRedis().ping();
  if (pong !== 'PONG') {
    throw new Error(`unexpected redis ping reply: ${pong}`);
  }
}

/** Close the client (tests / graceful shutdown). */
export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => client?.disconnect());
    client = null;
  }
}
