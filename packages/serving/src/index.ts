/**
 * @drobek/serving — pure serving building blocks (path resolution, cache
 * headers, content types, CSP, visibility gate, app passwords). The request
 * handler that serves versions from the apps origin arrives with M0-06; the
 * deploy-based `/:ws/app/:slug/*` handler was removed with the upload
 * pipeline (M0-02).
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
export { resolveWorkspaceId } from './workspace.server.js';
