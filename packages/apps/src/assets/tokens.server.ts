/**
 * Upload URLs for app assets (NSO-358): how a big file reaches drobek without
 * passing through an LLM. `create_asset_upload` (MCP, write scope) or the
 * dashboard's Assets tab mints one; the agent runs `curl -T <file> '<url>'`
 * in its own sandbox, or hands the link to the user.
 *
 * The URL is a capability: `<PUBLIC_APP_URL>/api/assets/upload/<token>` on
 * the dashboard host, the token 32 random bytes (base64url). Only its sha256
 * is stored — in Redis, `drobek:asset-upload:<sha256>`, with a 30-minute TTL
 * — bound to the app, the asset name, the declared size and content type and
 * the user who created it (the upload is audited as theirs). It is SINGLE-USE:
 * the PUT takes it (GETDEL) before reading a byte, so a failed upload needs a
 * new URL. Tokens are never logged.
 */
import { createHash, randomBytes } from 'node:crypto';
import { getRedis } from '@drobek/core';
import type { AuditActorKind } from '@drobek/audit';
import { UPLOAD_TOKEN_TTL_SEC, assetUploadsPerHour } from './config.js';

/** What an upload URL allows — exactly one asset of one app. */
export interface UploadGrant {
  appId: string;
  appSlug: string;
  workspaceId: string;
  name: string;
  size: number;
  /** The declared Content-Type ('' = none). */
  contentType: string;
  /** Who created the URL (the upload is audited as theirs). */
  userId: string;
  actorKind: AuditActorKind;
  via: 'mcp' | 'dashboard';
  /** Epoch ms. */
  expiresAt: number;
}

export interface UploadTokenStore {
  put(hash: string, grant: UploadGrant, ttlSec: number): Promise<void>;
  /** Read AND delete (single use). null when unknown, used or expired. */
  take(hash: string): Promise<UploadGrant | null>;
  /** Read without using it (the browser upload page shows what the link is for). */
  peek(hash: string): Promise<UploadGrant | null>;
}

const KEY_PREFIX = 'drobek:asset-upload:';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** The path of the upload endpoint on the dashboard host (`/api/assets/upload/<token>`). */
export const ASSET_UPLOAD_PATH_PREFIX = '/api/assets/upload/';

export function hashUploadToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function parseGrant(raw: string | null): UploadGrant | null {
  if (!raw) return null;
  try {
    const g = JSON.parse(raw) as Partial<UploadGrant>;
    if (typeof g.appId !== 'string' || typeof g.name !== 'string' || typeof g.size !== 'number' || typeof g.expiresAt !== 'number') return null;
    return g as UploadGrant;
  } catch {
    return null;
  }
}

/** The production store: Redis, GETDEL for the single use. */
export function redisUploadTokenStore(redis = getRedis): UploadTokenStore {
  return {
    async put(hash, grant, ttlSec) {
      await redis().set(`${KEY_PREFIX}${hash}`, JSON.stringify(grant), 'EX', ttlSec);
    },
    async take(hash) {
      return parseGrant(await redis().getdel(`${KEY_PREFIX}${hash}`));
    },
    async peek(hash) {
      return parseGrant(await redis().get(`${KEY_PREFIX}${hash}`));
    },
  };
}

/** An in-memory store (tests). */
export function memoryUploadTokenStore(now: () => number = Date.now): UploadTokenStore & { size(): number } {
  const map = new Map<string, { grant: string; until: number }>();
  return {
    async put(hash, grant, ttlSec) {
      map.set(hash, { grant: JSON.stringify(grant), until: now() + ttlSec * 1000 });
    },
    async take(hash) {
      const e = map.get(hash);
      map.delete(hash);
      return e && e.until > now() ? parseGrant(e.grant) : null;
    },
    async peek(hash) {
      const e = map.get(hash);
      return e && e.until > now() ? parseGrant(e.grant) : null;
    },
    size: () => map.size,
  };
}

/** Mint an upload token for `grant` (valid UPLOAD_TOKEN_TTL_SEC). The raw token is returned once and never stored. */
export async function createUploadToken(
  store: UploadTokenStore,
  grant: Omit<UploadGrant, 'expiresAt'>,
  now: () => number = Date.now
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = now() + UPLOAD_TOKEN_TTL_SEC * 1000;
  await store.put(hashUploadToken(token), { ...grant, expiresAt }, UPLOAD_TOKEN_TTL_SEC);
  return { token, expiresAt: new Date(expiresAt) };
}

/** Take (and so burn) the grant of `token`; null when malformed, unknown, used or expired. */
export async function consumeUploadToken(
  store: UploadTokenStore,
  token: string,
  now: () => number = Date.now
): Promise<UploadGrant | null> {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const grant = await store.take(hashUploadToken(token));
  if (!grant || grant.expiresAt <= now()) return null;
  return grant;
}

/** The grant of `token` WITHOUT using it; null when malformed, unknown, used or expired. */
export async function peekUploadToken(
  store: UploadTokenStore,
  token: string,
  now: () => number = Date.now
): Promise<UploadGrant | null> {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const grant = await store.peek(hashUploadToken(token));
  return grant && grant.expiresAt > now() ? grant : null;
}

/** The upload URL of a token on the dashboard origin. */
export function assetUploadUrl(dashboardOrigin: string, token: string): string {
  return `${dashboardOrigin.replace(/\/+$/, '')}${ASSET_UPLOAD_PATH_PREFIX}${token}`;
}

/** The shell line an agent (or a user) runs to upload `file` to `url`. */
export function curlUploadCommand(url: string, file = '<file>'): string {
  return `curl -T ${file} '${url}'`;
}

type UploadCounter = (appId: string, limit: number, windowMs: number) => Promise<boolean>;

const HOUR_MS = 60 * 60 * 1000;

/** INCR + PEXPIRE on `drobek:rl:asset-upload:<app_id>` (the rate-limit key scheme of @drobek/auth). */
const redisUploadCounter: UploadCounter = async (appId, limit, windowMs) => {
  const r = getRedis();
  const key = `drobek:rl:asset-upload:${appId}`;
  const n = await r.incr(key);
  if (n === 1) await r.pexpire(key, windowMs);
  return n <= limit;
};

/** May `appId` get another upload URL this hour (APP_ASSET_UPLOADS_PER_HOUR)? Counts the attempt. */
export async function assetUploadAllowed(
  appId: string,
  opts: { counter?: UploadCounter; env?: NodeJS.ProcessEnv } = {}
): Promise<boolean> {
  return (opts.counter ?? redisUploadCounter)(appId, assetUploadsPerHour(opts.env), HOUR_MS);
}
