/**
 * drobek-module-proxy — the BUILT-IN platform module `proxy` (M1-06, §5.6):
 * an app calls an external API without ever holding its secret.
 *
 *   DROBEK_MODULES=…,proxy  → this package (`modules/proxy` in the drobek repo,
 *                             a dependency of the server).
 *
 *   ANY /__drobek/v1/proxy/:upstream/*   drobek.proxy.fetch(upstream, path, init?) → Response
 *   config { upstreams: { <name>: { rules: { call }, rateLimit?, id? } } }   (id: set by drobek)
 *
 * Upstreams (base_url, allowed methods + path prefixes, the auth header and
 * its envelope-encrypted secret) are registered per WORKSPACE in the
 * dashboard by a workspace admin — never over MCP. The app's config assigns
 * one to the app (the owner confirms it) and names who may call it; the
 * gateway core (SSRF guard, port allow-list 80/443, secret injection) is
 * `@drobek/proxy`. get_app / configure_module show each upstream with
 * `hasSecret`, never the value.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineModule, type DrobekModule } from '@drobek/modules';
import {
  DEFAULT_CALLS_PER_MIN,
  DEFAULT_PUBLIC_CALLS_PER_MIN_PER_IP,
  PROXY_CONFIG_DEFAULTS,
  proxyConfigSchema,
  proxyConfirmRequired,
  proxyOnConfirmed,
  type ProxyConfig,
} from './config.js';
import { proxyAppInfo } from './info.js';
import { registerRoutes, type ProxyRouteOptions } from './routes.js';

export {
  DEFAULT_CALLS_PER_MIN,
  DEFAULT_CALL_RULE,
  DEFAULT_PUBLIC_CALLS_PER_MIN_PER_IP,
  MAX_UPSTREAMS_PER_APP,
  PROXY_CONFIG_DEFAULTS,
  assignmentOf,
  callRuleOf,
  proxyConfigSchema,
  proxyConfirmRequired,
  proxyOnConfirmed,
  upstreamAssignmentSchema,
  type ProxyConfig,
  type UpstreamAssignment,
} from './config.js';
export { proxyAppInfo, type UpstreamInfo } from './info.js';
export { PROXY_MAX_BODY_BYTES, proxyHandler, registerRoutes, toModuleError, type ProxyRouteOptions } from './routes.js';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** The SDK entry next to this file: dist/sdk.js when built, src/sdk.ts in a source checkout. */
const sdkEntry = existsSync(here('./sdk.js')) ? here('./sdk.js') : here('./sdk.ts');

export const SDK_TYPES = `
export interface Api {
  /**
   * fetch() an assigned upstream through drobek: \`path\` (and its ?query) is
   * appended to the upstream's base URL. The server injects the upstream's
   * secret; never put a key in the app. Resolves with the standard Response
   * (any status — check res.ok): drobek refusals are JSON { error, message }
   * with 401/403 (rules), 404 (not registered), 405/403 (method/path not
   * allowed), 429 (rate limited), 502 (upstream unreachable).
   */
  fetch(upstream: string, path?: string, init?: RequestInit): Promise<Response>;
}
`;

/** The module (tests pass their own env: allowed hosts/ports, the master key). */
export function createProxyModule(opts: ProxyRouteOptions = {}): DrobekModule<ProxyConfig> {
  return defineModule<ProxyConfig>({
    name: 'proxy',
    version: '1.0.0',
    skill: {
      useWhen:
        'the app calls an external API that needs a secret key (OpenAI, Anthropic, Stripe, any REST backend) — instead of putting the key in the browser',
      markdown: readFileSync(here('../SKILL.md'), 'utf8'),
    },
    configSchema: proxyConfigSchema,
    configDefaults: PROXY_CONFIG_DEFAULTS,
    confirmRequired: proxyConfirmRequired,
    onConfirmed: proxyOnConfirmed,
    rules: {
      ops: {
        call: 'Call an assigned upstream through /__drobek/v1/proxy/<upstream>/…',
      },
    },
    limits: [
      { env: 'PROXY_CALLS_PER_MIN', default: DEFAULT_CALLS_PER_MIN, meaning: 'proxy calls one app may make per minute (all upstreams together)' },
      {
        env: 'PROXY_PUBLIC_CALLS_PER_MIN_PER_IP',
        default: DEFAULT_PUBLIC_CALLS_PER_MIN_PER_IP,
        meaning: 'calls per minute from one client IP to an upstream whose call rule is public',
      },
    ],
    routes: registerRoutes(opts),
    appInfo: proxyAppInfo,
    sdk: { entry: sdkEntry, types: SDK_TYPES },
  });
}

const proxy = createProxyModule();

export default proxy;
