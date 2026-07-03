/**
 * @drobek/serving — U7 hardened same-origin path serving (PHY-58; PHY-52/82/76)
 * as a react-free workspace LIBRARY. The core logic (resolution, caching,
 * visibility gate, CSP, password) lives here; apps/web (and the saas web app)
 * register a thin `/:ws/app/:slug/*` route that calls `serveApp` /
 * `handleAppPasswordPost`. The deploy pipeline imports `bustServeCache` from
 * `@drobek/serving/cache` to invalidate on activate/rollback.
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
  etagFor,
  isNotModified,
  normalizeRequestPath,
  resolveServePath,
  type CacheDecision,
  type ResolveInput,
  type ResolveResult,
  type RoutingMode,
} from './resolve.js';
export {
  APP_CSP,
  appResponseHeaders,
  baseSecurityHeaders,
  type AppHeaderInput,
} from './csp.js';
export {
  decideVisibility,
  type Visibility,
  type VisibilityDecision,
  type VisibilityInput,
} from './visibility.js';
export {
  APP_ACCESS_COOKIE,
  APP_ACCESS_TTL_SEC,
  appAccessCookieHeader,
  hashAppPassword,
  mintAppAccessToken,
  verifyAppAccessToken,
  verifyAppPassword,
} from './password.js';
export {
  bustServeCache,
  getServeAppRecord,
  getServeManifest,
  loadAppPasswordHash,
  resolveWorkspaceId,
  type AppStatus,
  type ManifestFile,
  type ServeAppRecord,
  type ServeManifest,
} from './cache.server.js';
export {
  handleAppPasswordPost,
  renderPasswordPage,
  serveApp,
  setServeBlobStoreForTests,
  type ServeParams,
} from './serve.server.js';
