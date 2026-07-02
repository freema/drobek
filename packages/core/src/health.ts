import { healthDbPing } from '@drobek/db';
import { healthRedisPing } from './redis.js';

/**
 * D3 (ratified) health contract: `/healthz` returns the REAL dependency
 * state — `{ok, db, redis}` — and the web route maps `ok:false` to HTTP 503.
 * The MCP server's liveness path is `/health` (NOT /healthz) and stays a
 * static `{ok:true}`.
 */
export type HealthBody = {
  ok: boolean;
  db: 'up' | 'down';
  redis: 'up' | 'down';
};

export type Pinger = () => Promise<void>;

export type HealthCheckOverrides = {
  /** Injectable probes for unit tests; defaults hit real pg + redis. */
  dbPing?: Pinger;
  redisPing?: Pinger;
};

export async function runHealthChecks(
  overrides: HealthCheckOverrides = {}
): Promise<HealthBody> {
  const dbPing = overrides.dbPing ?? healthDbPing;
  const redisPing = overrides.redisPing ?? healthRedisPing;

  let db: HealthBody['db'] = 'down';
  let redis: HealthBody['redis'] = 'down';

  try {
    await dbPing();
    db = 'up';
  } catch {
    db = 'down';
  }

  try {
    await redisPing();
    redis = 'up';
  } catch {
    redis = 'down';
  }

  return {
    ok: db === 'up' && redis === 'up',
    db,
    redis,
  };
}
