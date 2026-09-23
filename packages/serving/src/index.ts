/**
 * @drobek/serving — the apps origin (M0-06): every app is served from its own
 * hosts under APPS_DOMAIN (`<slug>`, `<slug>--preview`, `<slug>--v<N>`) out of
 * its immutable versions. Host dispatch (`createAppsHostMiddleware`), the
 * request handler, the caches (+ their pub/sub bust), CSP and the password gate.
 */
export {
  DEFAULT_CONTENT_TYPE,
  contentTypeForPath,
  extensionOf,
  hasExtension,
} from './content-type.js';
export {
  ENTRY_HTML,
  IMMUTABLE_CACHE,
  REVALIDATE_CACHE,
  cacheControlFor,
  decodeRequestPath,
  etagFor,
  isNotModified,
  normalizeRequestPath,
  resolveServePath,
  type CacheInput,
  type ResolveInput,
  type ResolveResult,
  type RoutingMode,
} from './resolve.js';
export {
  APP_CSP,
  DEFAULT_FRAME_ANCESTORS,
  appCsp,
  appSecurityHeaders,
  parseFrameAncestors,
  type SecurityHeaderInput,
} from './csp.js';
export {
  decideVisibility,
  type Visibility,
  type VisibilityDecision,
  type VisibilityInput,
} from './visibility.js';
export {
  APP_ACCESS_COOKIE,
  APP_ACCESS_COOKIE_INSECURE,
  appAccessCookieName,
  appCookiesSecure,
  APP_ACCESS_TTL_SEC,
  appAccessCookieHeader,
  appAccessSecret,
  hashAppPassword,
  mintAppAccessToken,
  verifyAppAccessToken,
  verifyAppPassword,
} from './password.js';
export { ByteLru, CountLru, DEFAULT_BLOB_CACHE_BYTES } from './lru.js';
export {
  isUnservedSource,
  servedManifest,
  type ServedFile,
  type ServedManifest,
  type StoredFile,
} from './manifest.js';
export { UNLOCK_PATH } from './pages.js';
export {
  UNLOCK_ATTEMPTS,
  UNLOCK_WINDOW_MS,
  handleAppRequest,
  APP_HEADER,
  type AppRequest,
  type AppResponse,
  type HandlerDeps,
  PLATFORM_PREFIX,
  BEACON_PATH,
  type BeaconHandler,
  type PlatformHandler,
} from './handler.js';
export {
  MAX_NEGATIVE_ENTRIES,
  NEGATIVE_TTL_MS,
  RESOLVE_TTL_MS,
  ServeStore,
  dbLoaders,
  type Resolved,
  type ServeApp,
  type ServeLoaders,
  type ServeStoreOptions,
  type ServeVersion,
} from './store.server.js';
export {
  DEFAULT_UNKNOWN_HOST_LIMIT,
  DEFAULT_UNKNOWN_HOST_WINDOW_MS,
  UnknownHostLimiter,
  unknownHostLimitsFromEnv,
  type UnknownHostCounter,
  type UnknownHostLimiterOptions,
  type UnknownHostLimits,
} from './unknown-host.js';
export { subscribeServeCache, type ServeCacheSubscription } from './subscriber.server.js';
export {
  createAppsHostMiddleware,
  defaultHandlerDeps,
  type AppsHostOptions,
  type NodeMiddleware,
} from './node.js';
export { resolveWorkspaceId } from './workspace.server.js';
export {
  TLS_ASK_PATH,
  TLS_ASK_TOKEN_HEADER,
  TLS_ASK_TOKEN_MIN_LENGTH,
  decideTlsAsk,
  tlsAskConfigError,
  tlsAskCustomHost,
  tlsAskSlug,
  tlsAskToken,
  tlsAskTokenMatches,
  type TlsAskDeps,
  type TlsAskInput,
  type TlsAskStatus,
} from './tls-ask.js';
export { appSlugIsLive, createTlsAskHandler, type TlsAskHandlerOptions } from './tls-ask.server.js';
