/**
 * @drobek/apps — apps and their immutable versions: create (global
 * slugs), write a version, publish (pointer move), restore (new version from
 * an old one), blob GC, unpublish, soft delete + slug
 * release, visibility / frame-ancestors settings, the single-writer lease
 * read/release and version ZIPs, and app assets (binary files at
 * `/<name>` next to the app's files, upload URLs). The MCP tools and the dashboard call these.
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
export { versionReadiness, versionSources, type VersionReadinessOptions } from './readiness.server.js';
export { scheduleVersionTypecheck } from './typecheck.server.js';
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
// Abuse reports, super-admin takedown/restore, publish heuristic.
export {
  ABUSE_QUEUE_PATH,
  DEFAULT_ABUSE_REPORTS_RETENTION_DAYS,
  LOCK_REASONS,
  REPORT_DETAILS_MAX,
  REPORT_FORM_PATH,
  REPORT_REASONS,
  REPORT_WELL_KNOWN_PATH,
  abuseReportsRetentionDays,
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
  pruneResolvedAbuseReports,
  reportIpHash,
  resolveAbuseReport,
  restoreApp,
  screenAfterPublish,
  screenPublishedVersion,
  takedownApp,
  takedownPreview,
  validateAbuseReport,
  type AbuseReportInput,
  type AbuseReportRow,
  type AbuseReportValidation,
  type AppLockState,
  type ModerationTarget,
  type ReportedApp,
  type ScreenResult,
  type TakedownPreview,
} from './moderation.server.js';
// App assets — binary files served at /<name> next to the app's files, upload URLs, the sweep.
export * from './assets/index.js';
export type {
  Actor,
  CompileStatus,
  VersionDetail,
  VersionFile,
  VersionFileInput,
  VersionFileKind,
  VersionSummary,
} from './types.js';
// The public gallery (owner opt-in, super-admin hide, the public list).
export {
  GALLERY_DESCRIPTION_MAX,
  GALLERY_OPENS_PRUNE_MARGIN_DAYS,
  GALLERY_OPENS_WINDOW_DAYS,
  GALLERY_PAGE_MAX,
  GALLERY_PAGE_SIZE,
  GALLERY_POPULAR_LIKE_WEIGHT,
  decodeGalleryCursor,
  encodeGalleryCursor,
  galleryEnabled,
  galleryPageNumber,
  galleryPageSize,
  gallerySort,
  galleryState,
  isGalleryVisible,
  isPrefetchRequest,
  normalizeGalleryDescription,
  type GalleryCursor,
  type GalleryDescriptionResult,
  type GallerySort,
  type GalleryState,
} from './gallery.js';
export {
  duplicatePageUrl,
  galleryLinks,
  listGallery,
  listGalleryForModeration,
  listGalleryPage,
  setGalleryHidden,
  setGalleryListing,
  type GalleryItem,
  type GalleryListingInput,
  type GalleryListingResult,
  type GalleryPage,
  type GalleryModerationEntry,
} from './gallery.server.js';
// Duplicating a gallery app into the caller's workspace (the files half).
export {
  DEFAULT_DUPLICATES_PER_USER_HOUR,
  DUPLICATE_NAME_MAX,
  copyName,
  defaultCopyName,
  duplicateAppFiles,
  duplicatesPerUserHour,
  duplicationSource,
  type DuplicateFilesInput,
  type DuplicationSource,
} from './duplicate.server.js';
// Gallery likes (signed-in accounts) and opens (the counting link).
export {
  galleryCounts,
  galleryEntryBySlug,
  galleryLikeState,
  pruneGalleryOpens,
  recordGalleryOpen,
  setGalleryLike,
  type GalleryEntry,
} from './gallery-engagement.server.js';
// Who may publish (PUBLISH_APPROVAL + a super-admin's per-workspace state) and the operator's publish e-mails (PUBLISH_NOTIFY).
export {
  PUBLISH_APPROVAL_MODES,
  PUBLISH_APPROVAL_PATH,
  PUBLISH_APPROVAL_REQUEST_EVERY_MS,
  PUBLISH_NOTIFY_MODES,
  WORKSPACE_PUBLISHING_STATES,
  isWorkspacePublishing,
  operatorContact,
  operatorEmails,
  publishApprovalConfigError,
  publishApprovalMode,
  publishApprovalNotice,
  publishBlockedMessage,
  publishBlockedNotice,
  publishNotApprovedMessage,
  publishNotifyMode,
  type PublishApprovalMode,
  type PublishNotifyMode,
  type WorkspacePublishing,
} from './publish-approval.js';
export {
  PUBLISHING_FILTERS,
  listWorkspacePublishing,
  publishPermission,
  publishPermissions,
  requestPublishApproval,
  setWorkspacePublishing,
  type PublishAllowedBy,
  type PublishApprovalRequestResult,
  type PublishPermission,
  type PublishingFilter,
  type WorkspacePublishingEntry,
} from './publish-approval.server.js';
export { notifyOperatorOfPublish, type PublishKind, type PublishNotifyResult } from './publish-notify.server.js';
