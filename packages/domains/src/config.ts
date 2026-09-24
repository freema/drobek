/**
 * Custom-domain settings from the environment (M3-01):
 *
 *   DOMAINS_MAX_PER_APP          domains per app, pending + verified (default 3;
 *                                0 = custom domains off). A limits provider
 *                                may set it per workspace (NSO-329): callers
 *                                pass that value to addDomain.
 *   DOMAINS_DNS_SERVERS          optional nameservers for verification, comma-
 *                                separated IPs (default: the system resolver)
 *   DOMAINS_RECHECK_INTERVAL_MS  how often the re-check sweep looks for domains
 *                                last checked 24 h+ ago (default 1 h)
 *   DOMAINS_DNS_MOCK=redis       DEV / E2E ONLY: answer DNS from Redis keys
 *                                (dns.ts `redisDnsMock`); ignored — with a warning —
 *                                when NODE_ENV=production. It also admits the
 *                                RFC 6761 `.test` TLD for custom domains.
 */
import { isIP } from 'node:net';
import { hostConfig } from '@drobek/apps';
import { getRedis } from '@drobek/core';
import { nodeDnsResolver, redisDnsMock, type DnsMockRedis, type DnsResolver } from './dns.js';
import type { HostnameRules } from './hostname.js';

export const DEFAULT_DOMAINS_MAX_PER_APP = 3;
export const DEFAULT_RECHECK_INTERVAL_MS = 60 * 60 * 1000;
/** A verified domain is re-checked once it was last checked this long ago. */
export const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;

function positiveInt(raw: string | undefined): number | null {
  const n = Number(raw?.trim());
  return raw !== undefined && raw.trim() !== '' && Number.isInteger(n) && n > 0 ? n : null;
}

/** A non-negative integer (DOMAINS_MAX_PER_APP=0 turns custom domains off). */
function nonNegativeInt(raw: string | undefined): number | null {
  const n = Number(raw?.trim());
  return raw !== undefined && raw.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : null;
}

/** The server-wide DOMAINS_MAX_PER_APP (the limits provider may lower or raise it per workspace). */
export function domainsMaxPerApp(env: NodeJS.ProcessEnv = process.env): number {
  return nonNegativeInt(env.DOMAINS_MAX_PER_APP) ?? DEFAULT_DOMAINS_MAX_PER_APP;
}

export function recheckIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1_000, positiveInt(env.DOMAINS_RECHECK_INTERVAL_MS) ?? DEFAULT_RECHECK_INTERVAL_MS);
}

/** True when the Redis DNS mock is active (set, and not in production). */
export function dnsMockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DOMAINS_DNS_MOCK?.trim().toLowerCase() === 'redis' && env.NODE_ENV !== 'production';
}

/** A warning for the log when the mock is requested where it is ignored; null otherwise. */
export function dnsMockWarning(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.DOMAINS_DNS_MOCK?.trim();
  if (!raw) return null;
  if (env.NODE_ENV === 'production') return 'DOMAINS_DNS_MOCK is ignored in production — custom domains use real DNS';
  if (raw.toLowerCase() !== 'redis') return `DOMAINS_DNS_MOCK=${raw} is not supported (only "redis") — using real DNS`;
  return null;
}

/** Startup check: a human-readable error for a malformed DOMAINS_* value, else null. */
export function domainsConfigError(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.DOMAINS_MAX_PER_APP?.trim() && nonNegativeInt(env.DOMAINS_MAX_PER_APP) === null) {
    return 'drobek refuses to start: DOMAINS_MAX_PER_APP must be a whole number (0 turns custom domains off).';
  }
  const servers = dnsServers(env);
  if (servers.some((s) => isIP(s) === 0)) {
    return 'drobek refuses to start: DOMAINS_DNS_SERVERS must be a comma-separated list of IP addresses.';
  }
  return null;
}

function dnsServers(env: NodeJS.ProcessEnv): string[] {
  return (env.DOMAINS_DNS_SERVERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** The resolver verification uses: the Redis mock in dev/e2e when asked for, else node:dns. */
export function domainsResolver(env: NodeJS.ProcessEnv = process.env): DnsResolver {
  if (dnsMockEnabled(env)) return redisDnsMock(() => getRedis() as unknown as DnsMockRedis);
  return nodeDnsResolver({ servers: dnsServers(env) });
}

/** What checkHostname needs from the environment (APPS_DOMAIN, PUBLIC_APP_URL, the mock). */
export function hostnameRules(env: NodeJS.ProcessEnv = process.env): HostnameRules {
  const hosts = hostConfig(env);
  return { appsDomain: hosts.appsDomain, dashboardHost: hosts.dashboardHost, allowTestTld: dnsMockEnabled(env) };
}
