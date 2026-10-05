/**
 * @drobek/proxy — the secret-injecting, SSRF-guarded gateway core.
 * Upstreams (base_url, allow-lists, envelope-encrypted secret) are registered
 * per WORKSPACE in the dashboard; apps reach them through the `proxy` platform
 * module (`/__drobek/v1/proxy/:upstream/*` on the app host), which
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
  keyOf,
  keyRingFromEnv,
  previousKekFromEnv,
  rewrapSecret,
  type KeyRing,
  type RewrapResult,
  type SecretEnvelope,
} from './crypto.server.js';
export {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_RESPONSE_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_STREAM_MAX_BYTES,
  DEFAULT_STREAM_MAX_MS,
  openUpstreamRequest,
  proxyAllowedHosts,
  proxyResponseTimeoutMs,
  proxyStreamLimits,
  ssrfSafeForward,
  streamUpstreamBody,
  type OpenedUpstream,
  type StreamEnd,
  type StreamEndReason,
  type UpstreamRequestInput,
  type SsrfForwardInput,
  type SsrfForwardResult,
} from './ssrf.server.js';
export {
  PROXY_AUDIT_ACTIONS,
  PROXY_SUBJECT_TYPE,
  type ProxyAuditAction,
} from './audit-actions.js';
export {
  checkUpstreamFields,
  createUpstream,
  assertCanRegisterUpstream,
  DEFAULT_UPSTREAM_REGISTRATIONS_PER_HOUR,
  DEFAULT_UPSTREAMS_MAX_PER_WORKSPACE,
  upstreamRegistrationsPerHour,
  upstreamsMaxPerWorkspace,
  deleteUpstream,
  getUpstream,
  listUpstreams,
  resolveUpstreamForForward,
  allowAppOnUpstream,
  upstreamAllowsApp,
  upstreamSummaries,
  UPSTREAM_NAME_RE,
  type CheckedUpstreamFields,
  type ConfigureActor,
  type CreateUpstreamInput,
  type UpstreamRecord,
  type UpstreamSummary,
  type UpstreamView,
} from './upstreams.server.js';
export { forwardToUpstream, sseCutEvent, type ForwardInput, type ForwardResult, type StreamedForwardResult } from './forward.server.js';
export { DEFAULT_PROXY_MAX_CONCURRENT_PER_CALLER, acquireProxySlot } from './concurrency.server.js';
