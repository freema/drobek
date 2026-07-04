/**
 * @drobek/proxy — the PHY-59 BFF proxy v1 (authed workspace members). A static
 * app reaches a backend WITHOUT holding the secret; drobek is the controlled,
 * SSRF-guarded, secret-injecting gateway. React-free server logic; the thin
 * `/:ws/api/proxy/:name/*` route lives under the `@drobek/proxy/route` subpath.
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
  validateBaseUrl,
  type AllowedMethod,
  type ValidatedBaseUrl,
} from './validate.js';
export {
  buildForwardHeaders,
  filterResponseHeaders,
  type InjectAuthInput,
  type UpstreamAuthType,
} from './auth-inject.js';
export { canCallProxy, canConfigureUpstreams } from './authz.js';
export {
  decryptSecret,
  encryptSecret,
  kekFromEnv,
  type SecretEnvelope,
} from './crypto.server.js';
export {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  proxyAllowedHosts,
  ssrfSafeForward,
  type SsrfForwardInput,
  type SsrfForwardResult,
} from './ssrf.server.js';
export {
  DEFAULT_PROXY_RATE_LIMIT,
  DEFAULT_PROXY_RATE_WINDOW_MS,
  enforceProxyRateLimit,
} from './rate-limit.js';
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
  type ConfigureActor,
  type CreateUpstreamInput,
  type UpstreamRecord,
  type UpstreamView,
} from './upstreams.server.js';
export { forwardProxy, type ForwardInput } from './forward.server.js';
export {
  handleProxyRequest,
  proxyParamsOf,
  type ProxyRouteParams,
} from './route.server.js';
