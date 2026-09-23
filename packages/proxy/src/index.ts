/**
 * @drobek/proxy — the secret-injecting, SSRF-guarded gateway core (PHY-59).
 * Upstreams (base_url, allow-lists, envelope-encrypted secret) are registered
 * per WORKSPACE in the dashboard; apps reach them through the `proxy` platform
 * module (`/__drobek/v1/proxy/:upstream/*` on the app host, NSO-297), which
 * decides who may call and calls `forwardToUpstream`. React-free server logic.
 */
export {
  ProxyError,
  proxyErrorStatus,
  type ProxyErrorCode,
} from './errors.js';
export {
  classifyForwardIp,
  isBlockedIp,
  parseIpv4,
  parseIpv6,
  type IpVerdict,
} from './ip-classify.js';
export {
  ALLOWED_METHOD_SET,
  assertMethodAllowed,
  assertPathAllowed,
  buildTargetUrl,
  isAllowedMethodName,
  normalizeForwardPath,
  normalizeMethods,
  normalizePrefixes,
  pathMatchesPrefix,
  resolveForwardTarget,
  targetSubpath,
  validateBaseUrl,
  DEFAULT_PROXY_ALLOWED_PORTS,
  effectivePort,
  proxyAllowedPorts,
  type AllowedMethod,
  type ValidatedBaseUrl,
} from './validate.js';
export {
  buildForwardHeaders,
  filterResponseHeaders,
  type InjectAuthInput,
  type UpstreamAuthType,
} from './auth-inject.js';
export { canConfigureUpstreams } from './authz.js';
export {
  decryptSecret,
  encryptSecret,
  kekFromEnv,
  type SecretEnvelope,
} from './crypto.server.js';
export {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_FORWARD_DEADLINE_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  proxyAllowedHosts,
  ssrfSafeForward,
  type SsrfForwardInput,
  type SsrfForwardResult,
} from './ssrf.server.js';
export {
  PROXY_AUDIT_ACTIONS,
  PROXY_SUBJECT_TYPE,
  type ProxyAuditAction,
} from './audit-actions.js';
export {
  createUpstream,
  deleteUpstream,
  getUpstream,
  listUpstreams,
  resolveUpstreamForForward,
  allowAppOnUpstream,
  upstreamAllowsApp,
  upstreamSummaries,
  UPSTREAM_NAME_RE,
  type ConfigureActor,
  type CreateUpstreamInput,
  type UpstreamRecord,
  type UpstreamSummary,
  type UpstreamView,
} from './upstreams.server.js';
export { forwardToUpstream, type ForwardInput, type ForwardResult } from './forward.server.js';
