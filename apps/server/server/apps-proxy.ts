/**
 * Entry point of the apps-host proxy of path routing (`APPS_ROUTING_MODE=path`):
 * `node dist/server/apps-proxy.js`. Env: APPS_PROXY_TARGET (drobek's private
 * origin), APPS_BASE_URL (this proxy's public origin), PORT (default 3000).
 * See @drobek/serving apps-proxy and docs/RAILWAY.md.
 */
import { appsProxyConfig, startAppsProxy } from '@drobek/serving/apps-proxy';

const config = appsProxyConfig(process.env);
if (typeof config === 'string') {
  console.error(`[apps-proxy] ${config}`);
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3000);
const server = await startAppsProxy(config, Number.isInteger(port) && port > 0 ? port : 3000);
console.log(`[apps-proxy] ${config.appsHost} → ${config.target.origin} on :${port}`);
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
