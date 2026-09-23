/**
 * @drobek/apps — apps and their immutable versions (M0-02): create (global
 * slugs), write a version, publish (pointer move), restore (new version from
 * an old one), and blob GC. The MCP tools and the dashboard call these.
 */
export { AppsError, type AppsErrorCode } from './errors.js';
export {
  APP_SLUG_MAX,
  APP_SLUG_MIN,
  APP_SLUG_RE,
  RESERVED_APP_SLUGS,
  deriveSlug,
  suggestSlug,
  validateAppSlug,
} from './slug.js';
export { createApp, freeSlugSuggestion, type CreateAppInput } from './apps.server.js';
export {
  createVersion,
  getVersion,
  latestVersionNumber,
  listVersions,
  publish,
  readBlobs,
  readVersionFile,
  restore,
  type CreateVersionOptions,
} from './versions.server.js';
export {
  BLOB_GC_GRACE_MS,
  BLOB_GC_INTERVAL_MS,
  startBlobGc,
  sweepUnreferencedBlobs,
} from './gc.server.js';
export { withRedisLock } from './lock.server.js';
export {
  DEV_APPS_DOMAIN,
  appsOrigin,
  appsOriginConfigError,
  previewUrl,
  publishedUrl,
  type AppsOrigin,
} from './origin.js';
export type {
  Actor,
  CompileStatus,
  VersionDetail,
  VersionFile,
  VersionFileInput,
  VersionFileKind,
  VersionSummary,
} from './types.js';
