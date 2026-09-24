/**
 * @drobek/apps — apps and their immutable versions (M0-02): create (global
 * slugs), write a version, publish (pointer move), restore (new version from
 * an old one), and blob GC; since M2-01 also unpublish, soft delete + slug
 * release, visibility / frame-ancestors settings, the single-writer lease
 * read/release and version ZIPs. The MCP tools and the dashboard call these.
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
export { DEFAULT_APPS_MAX_PER_WORKSPACE, createApp, freeSlugSuggestion, type CreateAppInput } from './apps.server.js';
export {
  createVersion,
  getVersion,
  latestVersionNumber,
  listVersions,
  publish,
  readBlobs,
  readVersionFile,
  restore,
  versionZip,
  type CreateVersionOptions,
} from './versions.server.js';
export { crc32, zipStream, type ZipEntry } from './zip.js';
export {
  SLUG_RELEASE_AFTER_MS,
  SLUG_RELEASE_INTERVAL_MS,
  releaseDeletedAppSlugs,
  setAppVisibility,
  setFrameAncestors,
  slugReleaseAt,
  softDeleteApp,
  startSlugRelease,
  tombstoneSlug,
  unpublishApp,
  type ReleasedSlug,
  type VisibilityInput,
} from './lifecycle.server.js';
export {
  LEASE_KEY_PREFIX,
  leaseKey,
  parseLease,
  readAppLease,
  releaseAppLease,
  type Lease,
  type LeaseRedis,
} from './lease.server.js';
export {
  BLOB_GC_GRACE_MS,
  BLOB_GC_INTERVAL_MS,
  startBlobGc,
  sweepUnreferencedBlobs,
} from './gc.server.js';
export { withRedisLock } from './lock.server.js';
export {
  APP_CHANGED_CHANNEL,
  emitLocalAppChanged,
  notifyAppChanged,
  onLocalAppChanged,
  parseAppChangedEvent,
  type AppChangedEvent,
} from './events.js';
export {
  DEV_APPS_DOMAIN,
  appsOrigin,
  appsOriginConfigError,
  dashboardOrigin,
  hostConfig,
  previewUrl,
  publishedUrl,
  versionUrl,
  type AppsOrigin,
} from './origin.js';
export {
  appHostOf,
  classifyHost,
  isAppsOrigin,
  parseAppLabel,
  splitHost,
  type AppHostTarget,
  type HostClass,
  type HostConfig,
} from './host.js';
// M4-02 (NSO-293): abuse reports, super-admin takedown/restore, publish heuristic.
export {
  ABUSE_QUEUE_PATH,
  LOCK_REASONS,
  REPORT_DETAILS_MAX,
  REPORT_FORM_PATH,
  REPORT_REASONS,
  REPORT_WELL_KNOWN_PATH,
  isLockReason,
  isReportReason,
  lockCategory,
  lockedMessage,
  normalizeReportHost,
  reasonLabel,
  reportFormUrl,
  termsUrl,
  type LockReason,
  type ReportReason,
} from './moderation.js';
export {
  DEFAULT_ABUSE_BRAND_WORDS,
  brandWordsFromEnv,
  describeFinding,
  scanForPhishing,
  type HeuristicFile,
  type HeuristicFinding,
} from './heuristic.js';
export {
  appLockState,
  createAbuseReport,
  findAppByReportedHost,
  findModerationApp,
  listAbuseReports,
  listLockedApps,
  lockedByAdminError,
  reportIpHash,
  resolveAbuseReport,
  restoreApp,
  screenAfterPublish,
  screenPublishedVersion,
  takedownApp,
  validateAbuseReport,
  type AbuseReportInput,
  type AbuseReportRow,
  type AbuseReportValidation,
  type AppLockState,
  type ModerationTarget,
  type ReportedApp,
  type ScreenResult,
} from './moderation.server.js';
export type {
  Actor,
  CompileStatus,
  VersionDetail,
  VersionFile,
  VersionFileInput,
  VersionFileKind,
  VersionSummary,
} from './types.js';
