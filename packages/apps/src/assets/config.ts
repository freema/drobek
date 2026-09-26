/**
 * App asset limits and storage (NSO-358) — env numbers with production
 * defaults:
 *
 *   APP_ASSET_MAX_BYTES         bytes of one asset (default 100 MiB)
 *   APP_ASSETS_QUOTA            bytes of all assets of one app (default 1 GiB)
 *   APP_ASSET_UPLOADS_PER_HOUR  upload URLs one app may get per hour (default 60)
 *   ASSETS_DIR                  where the bytes live (default /data/assets)
 *
 * The first two are in the limits catalogue (`CORE_LIMITS`, @drobek/modules),
 * so a limits provider can set them per workspace: callers ask the module
 * runtime and pass the values down, like APPS_MAX_PER_WORKSPACE.
 */

export const DEFAULT_APP_ASSET_MAX_BYTES = 100 * 1024 * 1024;
export const DEFAULT_APP_ASSETS_QUOTA = 1024 * 1024 * 1024;
export const DEFAULT_APP_ASSET_UPLOADS_PER_HOUR = 60;
export const DEFAULT_ASSETS_DIR = '/data/assets';

/** How long an upload URL stays valid. */
export const UPLOAD_TOKEN_TTL_SEC = 30 * 60;

/** The two limits a request needs; from the limits provider, else the env. */
export interface AssetLimits {
  maxBytes: number;
  quota: number;
}

function positiveInt(raw: unknown, fallback: number): number {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** The server-wide limits (no workspace): the env, else the defaults. */
export function assetLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): AssetLimits {
  return {
    maxBytes: positiveInt(env.APP_ASSET_MAX_BYTES, DEFAULT_APP_ASSET_MAX_BYTES),
    quota: positiveInt(env.APP_ASSETS_QUOTA, DEFAULT_APP_ASSETS_QUOTA),
  };
}

/** A workspace's limits as the limits provider answers them (`{ APP_ASSET_MAX_BYTES, APP_ASSETS_QUOTA }`). */
export function assetLimitsOf(limits: Readonly<Record<string, number>>, env: NodeJS.ProcessEnv = process.env): AssetLimits {
  const base = assetLimitsFromEnv(env);
  return {
    maxBytes: positiveInt(limits.APP_ASSET_MAX_BYTES, base.maxBytes),
    quota: positiveInt(limits.APP_ASSETS_QUOTA, base.quota),
  };
}

export function assetUploadsPerHour(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.APP_ASSET_UPLOADS_PER_HOUR, DEFAULT_APP_ASSET_UPLOADS_PER_HOUR);
}

/** The operator's ASSETS_DIR (read per call, so tests can point it elsewhere). */
export function assetsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ASSETS_DIR?.trim() || DEFAULT_ASSETS_DIR;
}
