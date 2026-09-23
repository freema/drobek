/**
 * @drobek/domains — custom domains for apps (M3-01): hostname validation
 * (PSL, drobek-owned names refused), TXT + CNAME verification against an
 * injectable resolver, the per-app operations the dashboard calls, the host
 * lookups behind alias routing and Caddy's `ask` (@drobek/serving), and the
 * daily DNS re-check (apps/server background jobs).
 */
export { DomainsError, domainsErrorStatus, type DomainsErrorCode } from './errors.js';
export {
  PROJECT_DOMAIN,
  checkHostname,
  cnameTarget,
  verificationRecordName,
  verificationRecordValue,
  type HostnameCheck,
  type HostnameRules,
} from './hostname.js';
export {
  DNS_TIMEOUT_MS,
  checkDomainDns,
  dnsMockKey,
  nodeDnsResolver,
  redisDnsMock,
  type DnsMockRedis,
  type DnsResolver,
  type DomainDnsInput,
  type DomainDnsResult,
  type RecordStatus,
} from './dns.js';
export {
  DEFAULT_DOMAINS_MAX_PER_APP,
  DEFAULT_RECHECK_INTERVAL_MS,
  RECHECK_AFTER_MS,
  dnsMockEnabled,
  dnsMockWarning,
  domainsConfigError,
  domainsMaxPerApp,
  domainsResolver,
  hostnameRules,
  recheckIntervalMs,
} from './config.js';
export {
  addDomain,
  instructionsFor,
  listDomains,
  newVerificationToken,
  removeDomain,
  setPrimaryDomain,
  verifyDomain,
  type DomainActor,
  type DomainApp,
  type DomainInstructions,
  type DomainView,
  type VerifyOptions,
  type VerifyOutcome,
} from './domains.server.js';
export {
  customDomainAskAllowed,
  primaryDomainOf,
  resolveCustomHost,
  verifiedDomainsOf,
  type CustomHostResolution,
} from './lookup.server.js';
export {
  appOwnerAddresses,
  domainLostText,
  recheckDueDomains,
  startDomainRecheck,
  type DomainLostNotice,
  type RecheckOptions,
  type RecheckResult,
} from './recheck.server.js';
