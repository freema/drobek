/**
 * Custom-domain hostname validation (M3-01). Pure — env comes in as `HostnameRules`.
 *
 * A hostname an owner may attach to an app is:
 *  - normalised: trimmed, lower-cased, one trailing dot dropped, IDNA → ASCII
 *    (`bücher.de` → `xn--bcher-kva.de`); a pasted URL (`https://shop.firma.cz/`)
 *    is reduced to its host; a port, path or credentials are refused;
 *  - a DNS name: 2+ LDH labels (1–63 chars, no leading/trailing dash, no `_`),
 *    at most 253 characters — never an IP literal;
 *  - a registrable domain or a subdomain of one per the Public Suffix List
 *    (`psl`): `firma.cz` and `www.firma.cz` pass, a bare public suffix
 *    (`co.uk`, `github.io`) or an unlisted TLD (`firma.internal`) does not;
 *  - not a special-use name (`localhost`, `*.local`, `*.internal`, …) — the
 *    RFC 6761 `.test` TLD only when `allowTestTld` (the dev/e2e DNS mock);
 *  - not at or under APPS_DOMAIN, the dashboard host, or `drobek.app` (the
 *    project's own domain — never a customer's, whatever the instance).
 */
/// <reference path="./psl.d.ts" />
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { parse as pslParse } from 'psl';

/** The project's own registrable domain: never attachable as a custom domain. */
export const PROJECT_DOMAIN = 'drobek.app';

/** Special-use TLDs (RFC 6761 / 6762 / 8375 / ICANN private-use) — never public DNS names. */
const SPECIAL_TLDS = new Set(['localhost', 'local', 'internal', 'invalid', 'example', 'onion', 'arpa', 'lan', 'home', 'corp', 'test']);

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_HOSTNAME = 253;

export interface HostnameRules {
  /** APPS_DOMAIN (the port, if any, is ignored). */
  appsDomain: string;
  /** The dashboard host (PUBLIC_APP_URL), port ignored; null when unknown. */
  dashboardHost: string | null;
  /** Accept the `.test` TLD (dev / e2e with the DNS mock only). */
  allowTestTld?: boolean;
}

export type HostnameCheck =
  | { ok: true; hostname: string }
  | { ok: false; code: 'invalid_hostname' | 'hostname_not_allowed'; message: string };

function bare(host: string | null | undefined): string | null {
  if (!host) return null;
  const h = host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.+$/, '');
  return h || null;
}

function atOrUnder(host: string, domain: string | null): boolean {
  return domain !== null && (host === domain || host.endsWith(`.${domain}`));
}

const invalid = (message: string): HostnameCheck => ({ ok: false, code: 'invalid_hostname', message });
const notAllowed = (message: string): HostnameCheck => ({ ok: false, code: 'hostname_not_allowed', message });

/** Reduce what an owner typed to a candidate hostname (null → not even a host). */
function extractHost(raw: string): string | null {
  let value = raw.trim();
  if (value === '' || value.length > 1024) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (url.username || url.password || url.port || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
      return null;
    }
    value = url.hostname;
  } else if (value.endsWith('/')) {
    value = value.slice(0, -1);
  }
  if (/[\s/:?#@[\]\\]/.test(value)) return null;
  return value;
}

/** Validate + normalise an owner-supplied hostname against the rules above. */
export function checkHostname(raw: unknown, rules: HostnameRules): HostnameCheck {
  if (typeof raw !== 'string') return invalid('Enter a domain name, e.g. shop.example.com.');
  const extracted = extractHost(raw);
  if (extracted === null) {
    return invalid('Enter just the domain name (e.g. shop.example.com) — no port, path or spaces.');
  }
  const trimmed = extracted.toLowerCase().replace(/\.$/, '');
  if (isIP(trimmed) !== 0 || /^\d+(\.\d+)*$/.test(trimmed)) {
    return invalid('An IP address cannot be a custom domain — use a domain name.');
  }
  // IDNA (UTS #46) → ASCII; '' when the name cannot be converted.
  const hostname = domainToASCII(trimmed);
  if (!hostname) return invalid('That is not a valid domain name.');
  if (hostname.length > MAX_HOSTNAME) return invalid('That domain name is too long.');
  const labels = hostname.split('.');
  if (labels.length < 2) return invalid('Use a full domain name with a dot, e.g. shop.example.com.');
  if (!labels.every((l) => LABEL_RE.test(l))) {
    return invalid('Domain labels may only use letters, digits and inner dashes (1–63 characters each).');
  }

  const tld = labels[labels.length - 1];
  const testTld = tld === 'test' && rules.allowTestTld === true;
  if (SPECIAL_TLDS.has(tld) && !testTld) {
    return notAllowed(`.${tld} is a special-use name, not a public domain.`);
  }

  const apps = bare(rules.appsDomain);
  const dashboard = bare(rules.dashboardHost);
  if (atOrUnder(hostname, PROJECT_DOMAIN) || atOrUnder(hostname, apps) || atOrUnder(hostname, dashboard)) {
    return notAllowed('That name belongs to drobek itself — use a domain you own.');
  }

  if (!testTld) {
    const parsed = pslParse(hostname);
    if ('error' in parsed || !parsed.listed || !parsed.domain) {
      return notAllowed(
        'Use a registrable domain or a subdomain of one (e.g. example.com or shop.example.com) — not a bare public suffix.'
      );
    }
  }
  return { ok: true, hostname };
}

/** The TXT record name that proves ownership: `_drobek.<hostname>`. */
export function verificationRecordName(hostname: string): string {
  return `_drobek.${hostname}`;
}

/** The TXT record value: `drobek-verify=<token>`. */
export function verificationRecordValue(token: string): string {
  return `drobek-verify=${token}`;
}

/** The CNAME target of an app: `<slug>.<APPS_DOMAIN>` (port dropped — DNS has none). */
export function cnameTarget(slug: string, appsDomain: string): string {
  return `${slug}.${bare(appsDomain) ?? appsDomain}`;
}
