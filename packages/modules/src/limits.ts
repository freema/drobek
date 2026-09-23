/**
 * Limits per workspace (§5.7) — `ctx.limits()` for module handlers.
 *
 * Default: every limit is its env var (`FORMS_PER_APP_PER_DAY=…`) or the
 * default the declaring module ships. A SaaS operator plugs plans in with
 * `LIMITS_PROVIDER_URL`: drobek then asks
 *
 *   GET <LIMITS_PROVIDER_URL>/limits/<workspace_id>
 *   X-Drobek-Timestamp: <unix seconds>
 *   X-Drobek-Signature: v1=<hex HMAC-SHA256(LIMITS_PROVIDER_SECRET, "<ts>.GET./limits/<workspace_id>")>
 *
 * and expects `{ "limits": { "<ENV_NAME>": <positive integer>, … } }`. Known
 * names override the env defaults; unknown names and bad values are ignored.
 * Answers are cached in Redis for 60 s (`drobek:limits:<workspace_id>`). When
 * the provider is down, slow (> 2 s) or answers garbage, the env defaults
 * apply and a warning is logged — a provider outage never takes apps down.
 */
import { createHmac } from 'node:crypto';
import type { Logger } from '@drobek/core';
import type { Limits, ModuleLimit } from './contract.js';

export const LIMITS_CACHE_TTL_SEC = 60;
export const LIMITS_PROVIDER_TIMEOUT_MS = 2_000;
export const LIMITS_PROVIDER_SECRET_MIN_LENGTH = 32;
/** After a provider failure, env defaults are used for this long before retrying. */
export const LIMITS_FAILURE_BACKOFF_MS = 10_000;

export const LIMITS_SIGNATURE_HEADER = 'X-Drobek-Signature';
export const LIMITS_TIMESTAMP_HEADER = 'X-Drobek-Timestamp';

export interface LimitsProvider {
  forWorkspace(workspaceId: string): Promise<Limits>;
  /** The env-level values (no workspace): what skill_info documents. */
  defaults(): Limits;
}

type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
};

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface LimitsProviderOptions {
  catalogue: ModuleLimit[];
  env?: NodeJS.ProcessEnv;
  redis?: () => RedisLike;
  fetch?: FetchLike;
  log?: Logger;
  now?: () => number;
}

function positiveInt(raw: unknown): number | null {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
}

/** HMAC-SHA256 signature of one provider request (exported for the provider side + tests). */
export function signLimitsRequest(secret: string, timestampSec: number, path: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestampSec}.GET.${path}`).digest('hex')}`;
}

/** Startup check: LIMITS_PROVIDER_URL needs an http(s) URL and a strong secret. */
export function limitsProviderConfigError(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = env.LIMITS_PROVIDER_URL?.trim();
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
  } catch {
    return 'drobek refuses to start: LIMITS_PROVIDER_URL must be an http(s) URL.';
  }
  const secret = env.LIMITS_PROVIDER_SECRET?.trim() ?? '';
  if (secret.length < LIMITS_PROVIDER_SECRET_MIN_LENGTH || /change-?me/i.test(secret)) {
    return `drobek refuses to start: LIMITS_PROVIDER_URL is set, so LIMITS_PROVIDER_SECRET must be a random value of at least ${LIMITS_PROVIDER_SECRET_MIN_LENGTH} characters (openssl rand -hex 32).`;
  }
  return null;
}

export function createLimitsProvider(opts: LimitsProviderOptions): LimitsProvider {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const log = opts.log;
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const known = new Set(opts.catalogue.map((l) => l.env));

  const envLimits: Record<string, number> = {};
  for (const l of opts.catalogue) envLimits[l.env] = positiveInt(env[l.env]) ?? l.default;
  const defaults = Object.freeze({ ...envLimits });

  const base = env.LIMITS_PROVIDER_URL?.trim().replace(/\/+$/, '') || null;
  const secret = env.LIMITS_PROVIDER_SECRET?.trim() ?? '';
  let backoffUntil = 0;

  function merge(remote: Record<string, unknown>): Limits {
    const out: Record<string, number> = { ...envLimits };
    for (const [k, v] of Object.entries(remote)) {
      const n = positiveInt(v);
      if (known.has(k) && n !== null) out[k] = n;
    }
    return Object.freeze(out);
  }

  async function fromProvider(workspaceId: string): Promise<Record<string, unknown>> {
    const path = `/limits/${encodeURIComponent(workspaceId)}`;
    const ts = Math.floor(now() / 1000);
    const res = await doFetch(`${base}${path}`, {
      headers: {
        Accept: 'application/json',
        [LIMITS_TIMESTAMP_HEADER]: String(ts),
        [LIMITS_SIGNATURE_HEADER]: signLimitsRequest(secret, ts, path),
      },
      signal: AbortSignal.timeout(LIMITS_PROVIDER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`limits provider answered ${res.status}`);
    const body = (await res.json()) as { limits?: unknown };
    if (!body || typeof body.limits !== 'object' || body.limits === null || Array.isArray(body.limits)) {
      throw new Error('limits provider answered without a `limits` object');
    }
    return body.limits as Record<string, unknown>;
  }

  return {
    defaults: () => defaults,
    async forWorkspace(workspaceId) {
      if (!base) return defaults;
      if (now() < backoffUntil) return defaults;
      const key = `drobek:limits:${workspaceId}`;
      const redis = opts.redis?.();
      try {
        const cached = redis ? await redis.get(key) : null;
        if (cached) return merge(JSON.parse(cached) as Record<string, unknown>);
      } catch {
        // cache miss on a Redis hiccup — ask the provider
      }
      try {
        const remote = await fromProvider(workspaceId);
        try {
          await redis?.set(key, JSON.stringify(remote), 'EX', LIMITS_CACHE_TTL_SEC);
        } catch {
          // caching is best effort
        }
        return merge(remote);
      } catch (err) {
        backoffUntil = now() + LIMITS_FAILURE_BACKOFF_MS;
        log?.warn('limits provider unavailable — using the env defaults', {
          workspace_id: workspaceId,
          error: String((err as Error)?.message ?? err),
        });
        return defaults;
      }
    },
  };
}
