/**
 * Deploy-pipeline constants + env-driven quota (U6, PHY-57 / PHY-100).
 *
 * The BullMQ queue lives on the SHARED redis, so it MUST be namespaced with the
 * `drobek` PREFIX (BullMQ's own key prefix — NOT ioredis keyPrefix) to avoid
 * colliding with puls' queues. All ad-hoc redis keys are `drobek:`-prefixed.
 */

/** BullMQ queue name (deploy jobs). */
export const DEPLOY_QUEUE = 'deploys';

/** BullMQ key prefix — isolates drobek's queues from puls on the shared redis. */
export const QUEUE_PREFIX = 'drobek';

/** Upload tokens minted by deploy_init are valid for this window. */
export const UPLOAD_TOKEN_TTL_SEC = 15 * 60;

/** Dev-generous defaults (documented in .env.example). */
export const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB per file
export const DEFAULT_MAX_APP_BYTES = 100 * 1024 * 1024; // 100 MiB per deploy

export interface QuotaLimits {
  /** Hard cap on any single file's declared bytes. */
  maxFileBytes: number;
  /** Hard cap on the sum of one deploy's declared bytes. */
  maxAppBytes: number;
}

function intEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Resolve the quota limits from DEPLOY_MAX_FILE_BYTES / DEPLOY_MAX_APP_BYTES. */
export function quotaLimitsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): QuotaLimits {
  return {
    maxFileBytes: intEnv(env.DEPLOY_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES),
    maxAppBytes: intEnv(env.DEPLOY_MAX_APP_BYTES, DEFAULT_MAX_APP_BYTES),
  };
}

/** Public origin the signed-upload PUT URLs (and app URLs) are built from. */
export function publicAppUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.PUBLIC_APP_URL?.trim() || 'http://localhost:3041').replace(
    /\/+$/,
    ''
  );
}

/** Provisional public URL for a deployed app (U7 finalizes the serving route). */
export function appUrl(slug: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${publicAppUrl(env)}/a/${slug}`;
}

/** Redis pub/sub channel the worker streams a deploy's progress on. */
export function deployChannel(deployId: string): string {
  return `drobek:deploy:${deployId}`;
}

/** Per-app advisory-lock key (serializes concurrent deploys of one app). */
export function appLockKey(appId: string): string {
  return `drobek:deploylock:${appId}`;
}
