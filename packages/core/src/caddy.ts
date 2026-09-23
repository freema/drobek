/**
 * Caddyfile generator (M0-07) — `task caddy:config` renders the TLS front of a
 * drobek deployment from the environment. Pure: env in, text out.
 *
 * Two sites, both reverse-proxied to drobek (`DROBEK_UPSTREAM`, default
 * `drobek:3000`):
 *  - the dashboard host (the host of PUBLIC_APP_URL) — a normal ACME
 *    certificate (HTTP-01/TLS-ALPN), or Caddy's local CA with TLS_INTERNAL=1;
 *  - `*.<APPS_DOMAIN>` — every app host — in exactly ONE of these modes:
 *      internal       TLS_INTERNAL=1: Caddy's local CA (development)
 *      wildcard-file  TLS_WILDCARD_CERT_FILE + TLS_WILDCARD_KEY_FILE: an
 *                     operator-supplied wildcard certificate (renewed outside
 *                     Caddy; `task tls:reload` picks up a new file)
 *      dns            TLS_DNS_PROVIDER (+ TLS_DNS_PROVIDER_ARGS,
 *                     TLS_DNS_CHALLENGE_OVERRIDE_DOMAIN): a wildcard via
 *                     ACME DNS-01, needs a Caddy built with that DNS module
 *      on-demand      none of the above: one certificate per app host, issued
 *                     at the first TLS handshake — ALWAYS gated by drobek's
 *                     `ask` endpoint (never unbounded on-demand issuance)
 *    Ambiguous combinations are refused, not guessed.
 *
 * Proxy contract with drobek: the original Host passes through untouched
 * (drobek dispatches app vs dashboard on it and ignores X-Forwarded-Host);
 * `X-Real-IP` is OVERWRITTEN with the TCP peer (`{remote_host}`), so a
 * client-sent value never reaches drobek — run drobek with
 * TRUST_PROXY=x-real-ip. `/api/internal/*` (the ask endpoint) is refused on
 * every public site; only Caddy calls it, over the internal network.
 *
 * No secret is ever written into the file: the ask token is referenced as
 * `{$TLS_ASK_TOKEN}` (substituted from Caddy's own environment when it loads
 * the config) and DNS credentials should be `{env.NAME}` placeholders.
 */

export type CaddyTlsMode = 'internal' | 'wildcard-file' | 'dns' | 'on-demand';

export interface CaddyConfig {
  mode: CaddyTlsMode;
  /** The dashboard site address, e.g. `drobek.app` or `localhost:8443`. */
  dashboardSite: string;
  /** APPS_DOMAIN, e.g. `drobek.app` → site `*.drobek.app`. */
  appsDomain: string;
  /** host:port of drobek on the internal network. */
  upstream: string;
  acmeEmail: string | null;
  wildcard: { certFile: string; keyFile: string } | null;
  dns: { provider: string; args: string[]; overrideDomain: string | null } | null;
}

export type CaddyConfigResult = { ok: true; config: CaddyConfig } | { ok: false; errors: string[] };

export const TLS_ASK_PATH = '/api/internal/tls/ask';
/** 32 characters ≈ 190 bits for a hex / base64url token. */
export const TLS_ASK_TOKEN_MIN_LENGTH = 32;

/** URL-safe (it rides in the ask URL) and long enough. */
export function isValidTlsAskToken(value: string | null | undefined): boolean {
  return (
    typeof value === 'string' &&
    value.length >= TLS_ASK_TOKEN_MIN_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
const HOST_PORT_RE = new RegExp(`^(${LABEL}(?:\\.${LABEL})*)(?::(\\d{1,5}))?$`);
const ABS_PATH_RE = /^\/[A-Za-z0-9._/-]+$/;
const DNS_PROVIDER_RE = /^[a-z0-9_]+$/;
/** A literal (no spaces, braces, quotes, #) or a `{env.NAME}` / `{$NAME}` placeholder. */
const DNS_ARG_RE = /^(?:\{env\.[A-Za-z_][A-Za-z0-9_]*\}|\{\$[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z0-9._:/@=+-]+)$/;
const EMAIL_RE = /^[^\s@{}"#]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

function flag(name: string, raw: string | undefined, errors: string[]): boolean {
  const v = raw?.trim().toLowerCase();
  if (!v || v === '0' || v === 'false' || v === 'no') return false;
  if (v === '1' || v === 'true' || v === 'yes') return true;
  errors.push(`${name} must be 1/true or 0/false`);
  return false;
}

function validPort(p: string | undefined): boolean {
  return p === undefined || (Number(p) >= 1 && Number(p) <= 65535);
}

/** Read and strictly validate the Caddy-relevant environment. */
export function caddyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CaddyConfigResult {
  const errors: string[] = [];
  const val = (name: string) => env[name]?.trim() || undefined;

  // ── dashboard host ──
  let dashboardSite = '';
  const publicUrl = val('PUBLIC_APP_URL') ?? val('PUBLIC_ORIGIN');
  if (!publicUrl) {
    errors.push('PUBLIC_APP_URL is not set (the dashboard URL, e.g. https://drobek.example.com)');
  } else {
    let url: URL | null = null;
    try {
      url = new URL(publicUrl);
    } catch {
      errors.push('PUBLIC_APP_URL is not a valid URL');
    }
    if (url) {
      if (url.protocol !== 'https:') {
        errors.push('PUBLIC_APP_URL must be an https:// URL when Caddy terminates TLS');
      } else if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username) {
        errors.push('PUBLIC_APP_URL must be a bare origin (no path, query or credentials)');
      } else if (!HOSTNAME_RE.test(url.hostname) || /(^|\.)\d+$/.test(url.hostname)) {
        errors.push('PUBLIC_APP_URL must name a DNS host (not an IP literal)');
      } else {
        dashboardSite = url.host; // URL drops :443 itself
      }
    }
  }

  // ── apps domain ──
  let appsDomain = '';
  const rawApps = val('APPS_DOMAIN')?.toLowerCase();
  if (!rawApps) {
    errors.push('APPS_DOMAIN is not set (apps live on *.<APPS_DOMAIN>)');
  } else {
    const m = HOST_PORT_RE.exec(rawApps);
    if (!m || !validPort(m[2])) {
      errors.push('APPS_DOMAIN must be a bare host name with an optional :port, e.g. apps.example.com');
    } else {
      appsDomain = m[2] === '443' ? m[1] : rawApps;
    }
  }
  const scheme = val('APPS_URL_SCHEME')?.toLowerCase();
  if (scheme && scheme !== 'https') {
    errors.push('APPS_URL_SCHEME must be https (or unset) when Caddy terminates TLS');
  }

  const upstream = val('DROBEK_UPSTREAM') ?? 'drobek:3000';
  const um = HOST_PORT_RE.exec(upstream);
  if (!um || !um[2] || !validPort(um[2])) {
    errors.push('DROBEK_UPSTREAM must be host:port, e.g. drobek:3000');
  }

  const acmeEmail = val('TLS_ACME_EMAIL') ?? null;
  if (acmeEmail && !EMAIL_RE.test(acmeEmail)) errors.push('TLS_ACME_EMAIL is not a valid e-mail address');

  // ── TLS mode for *.<APPS_DOMAIN> ──
  const internal = flag('TLS_INTERNAL', env.TLS_INTERNAL, errors);

  const certFile = val('TLS_WILDCARD_CERT_FILE');
  const keyFile = val('TLS_WILDCARD_KEY_FILE');
  let wildcard: CaddyConfig['wildcard'] = null;
  if (certFile || keyFile) {
    if (!certFile || !keyFile) {
      errors.push('TLS_WILDCARD_CERT_FILE and TLS_WILDCARD_KEY_FILE must be set together');
    } else if (!ABS_PATH_RE.test(certFile) || !ABS_PATH_RE.test(keyFile)) {
      errors.push(
        'TLS_WILDCARD_CERT_FILE / TLS_WILDCARD_KEY_FILE must be absolute paths inside the Caddy container (e.g. /certs/wildcard.crt) — letters, digits, . _ - / only'
      );
    } else {
      wildcard = { certFile, keyFile };
    }
  }

  const provider = val('TLS_DNS_PROVIDER')?.toLowerCase();
  const rawArgs = val('TLS_DNS_PROVIDER_ARGS');
  const override = val('TLS_DNS_CHALLENGE_OVERRIDE_DOMAIN')?.toLowerCase().replace(/\.$/, '');
  let dns: CaddyConfig['dns'] = null;
  if (provider) {
    const args = rawArgs ? rawArgs.split(/\s+/) : [];
    if (!DNS_PROVIDER_RE.test(provider)) {
      errors.push('TLS_DNS_PROVIDER must be a Caddy DNS provider name, e.g. cloudflare');
    } else if (args.some((a) => !DNS_ARG_RE.test(a))) {
      errors.push(
        'TLS_DNS_PROVIDER_ARGS may only hold {env.NAME} placeholders and plain values (no spaces inside a value, no braces, quotes or #)'
      );
    } else if (override && !HOSTNAME_RE.test(override.replace(/^_/, 'x'))) {
      errors.push('TLS_DNS_CHALLENGE_OVERRIDE_DOMAIN must be a domain name, e.g. _acme-challenge.acme-zone.example.net');
    } else {
      dns = { provider, args, overrideDomain: override ?? null };
    }
  } else if (rawArgs || override) {
    errors.push('TLS_DNS_PROVIDER_ARGS / TLS_DNS_CHALLENGE_OVERRIDE_DOMAIN need TLS_DNS_PROVIDER');
  }

  const chosen = [internal && 'TLS_INTERNAL', (certFile || keyFile) && 'TLS_WILDCARD_CERT_FILE', provider && 'TLS_DNS_PROVIDER'].filter(
    Boolean
  );
  if (chosen.length > 1) {
    errors.push(`ambiguous TLS configuration: set only one of ${chosen.join(', ')}`);
  }

  const mode: CaddyTlsMode = internal ? 'internal' : wildcard ? 'wildcard-file' : dns ? 'dns' : 'on-demand';
  if (mode === 'on-demand' && chosen.length === 0 && !isValidTlsAskToken(val('TLS_ASK_TOKEN'))) {
    errors.push(
      `on-demand TLS (no TLS_INTERNAL / TLS_WILDCARD_CERT_FILE / TLS_DNS_PROVIDER) needs TLS_ASK_TOKEN — at least ${TLS_ASK_TOKEN_MIN_LENGTH} URL-safe characters, e.g. \`openssl rand -hex 32\`; it must be set for BOTH drobek and caddy`
    );
  }
  if (acmeEmail && mode === 'internal') {
    errors.push('TLS_ACME_EMAIL has no effect with TLS_INTERNAL=1 (no ACME) — unset one of them');
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: { mode, dashboardSite, appsDomain, upstream, acmeEmail, wildcard, dns } };
}

const MODE_NOTE: Record<CaddyTlsMode, string> = {
  internal: "internal — Caddy's local CA for every site (development only; trust its root to avoid warnings)",
  'wildcard-file':
    'wildcard-file — operator-supplied wildcard certificate for the app hosts; after renewing the files run `task tls:reload`',
  dns: 'dns — wildcard certificate for the app hosts via ACME DNS-01 (Caddy must be built with the DNS module: deployments/Dockerfile.caddy)',
  'on-demand':
    "on-demand — one certificate per app host, issued at the first handshake and ONLY when drobek's ask endpoint says the app exists",
};

/** Render the Caddyfile (tabs, like `caddy fmt`). */
export function renderCaddyfile(config: CaddyConfig): string {
  const { mode, upstream } = config;
  const out: string[] = [
    '# drobek Caddyfile — GENERATED by `task caddy:config` from the environment.',
    '# Do not edit by hand: change .env and re-run the task. Contains no secrets.',
    `# TLS mode: ${MODE_NOTE[mode]}`,
    '',
  ];

  const globals: string[] = [];
  if (config.acmeEmail) globals.push(`\temail ${config.acmeEmail}`);
  if (mode === 'internal') {
    globals.push('\t# The root CA lives in the caddy_data volume; never touch the host trust store.');
    globals.push('\tskip_install_trust');
  }
  if (mode === 'on-demand') {
    globals.push(
      '\t# Caddy asks drobek before EVERY new certificate; drobek answers 200 only for',
      '\t# <slug>[--preview|--v<N>].<APPS_DOMAIN> of an existing app. {$TLS_ASK_TOKEN}',
      "\t# is substituted from Caddy's environment when the config is loaded.",
      '\ton_demand_tls {',
      `\t\task http://${upstream}${TLS_ASK_PATH}?token={$TLS_ASK_TOKEN}`,
      '\t}'
    );
  }
  if (globals.length > 0) out.push('{', ...globals, '}', '');

  out.push(
    '(drobek) {',
    '\t# Internal endpoints (the TLS ask) are for Caddy only — never public.',
    '\t@internal path /api/internal /api/internal/*',
    '\thandle @internal {',
    '\t\trespond 404',
    '\t}',
    '\thandle {',
    `\t\treverse_proxy ${upstream} {`,
    '\t\t\t# Host passes through untouched (drobek dispatches on it). X-Real-IP is',
    '\t\t\t# REPLACED with the TCP peer, so a client-sent value never reaches drobek',
    '\t\t\t# (run drobek with TRUST_PROXY=x-real-ip).',
    '\t\t\theader_up X-Real-IP {remote_host}',
    '\t\t}',
    '\t}',
    '}',
    ''
  );

  const dashboardTls = mode === 'internal' ? ['\ttls internal'] : [];
  out.push(`# Dashboard, OAuth and MCP (PUBLIC_APP_URL).`, `${config.dashboardSite} {`, ...dashboardTls, '\timport drobek', '}', '');

  let appsTls: string[];
  switch (mode) {
    case 'internal':
      appsTls = ['\ttls internal'];
      break;
    case 'wildcard-file':
      appsTls = [`\ttls ${config.wildcard!.certFile} ${config.wildcard!.keyFile}`];
      break;
    case 'dns': {
      const dns = config.dns!;
      appsTls = [
        '\ttls {',
        `\t\tdns ${[dns.provider, ...dns.args].join(' ')}`,
        ...(dns.overrideDomain ? [`\t\tdns_challenge_override_domain ${dns.overrideDomain}`] : []),
        '\t}',
      ];
      break;
    }
    case 'on-demand':
      appsTls = ['\ttls {', '\t\ton_demand', '\t}'];
      break;
  }
  out.push(`# Every app host: <slug>, <slug>--preview, <slug>--v<N> (APPS_DOMAIN).`, `*.${config.appsDomain} {`, ...appsTls, '\timport drobek', '}', '');
  return out.join('\n');
}

/** env → Caddyfile, or the list of configuration errors. */
export function caddyfileFromEnv(
  env: NodeJS.ProcessEnv = process.env
): { ok: true; caddyfile: string; mode: CaddyTlsMode } | { ok: false; errors: string[] } {
  const r = caddyConfigFromEnv(env);
  if (!r.ok) return r;
  return { ok: true, caddyfile: renderCaddyfile(r.config), mode: r.config.mode };
}
