import { runHealthChecks } from '@drobek/core';

/**
 * D3 (ratified): real dependency health — `{ok, db, redis}`, HTTP 503 when
 * any dependency is down. `no-store` so proxies/browsers never cache a
 * stale verdict.
 */
export async function loader(): Promise<Response> {
  const body = await runHealthChecks();
  return Response.json(body, {
    status: body.ok ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
