import { runHealthChecks } from '@drobek/core';
import { activeModules } from '@drobek/modules';

/**
 * D3 (ratified): real dependency health — `{ok, db, redis}`, HTTP 503 when
 * any dependency is down. `no-store` so proxies/browsers never cache a
 * stale verdict. NSO-345: plus the active platform modules
 * (`modules: [{ name, version, source, contract }]`, no paths).
 */
export async function loader(): Promise<Response> {
  const [body, modules] = await Promise.all([runHealthChecks(), activeModules()]);
  return Response.json(
    { ...body, modules },
    {
      status: body.ok ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    }
  );
}
