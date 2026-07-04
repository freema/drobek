/**
 * @drobek/deploy — the U6 deploy pipeline (PHY-57 / PHY-70 / PHY-63 / PHY-100)
 * as a workspace LIBRARY. Pure Node/server logic ONLY (no react / react-router)
 * so the Express mcp-server + the worker entry import it thin.
 *
 * The MCP tools (deploy_init / deploy_commit / deploy_status / rollback) are
 * registered by @drobek/oauth/resource, which calls the functions exported
 * here. The web SSE route imports the react-free `@drobek/deploy/events`
 * subpath (which pulls NO bullmq into the web bundle).
 */
export {
  DEPLOY_QUEUE,
  QUEUE_PREFIX,
  UPLOAD_TOKEN_TTL_SEC,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_APP_BYTES,
  quotaLimitsFromEnv,
  publicAppUrl,
  appUrl,
  deployChannel,
  appLockKey,
  type QuotaLimits,
} from './constants.js';
export { DeployError, type DeployErrorCode } from './errors.js';
export { type DeployState, isTerminalState } from './types.js';
export { deriveSlug, slugCandidate, APP_SLUG_MAX } from './slug.js';
export {
  isLintable,
  lintFile,
  lintFiles,
  lintErrorSummary,
  type LintFinding,
  type LintReport,
} from './lint.js';
export {
  normalizeManifestPath,
  validateManifest,
  selectMissingUploads,
  type ManifestEntry,
  type ValidatedManifest,
} from './manifest.js';
export {
  chooseRollbackTarget,
  type RollbackCandidate,
  type RollbackChoice,
} from './rollback-target.js';
export {
  selectOrphans,
  sweepOrphanBlobs,
  type OrphanSweepDeps,
  type OrphanSweepResult,
} from './orphan-sweep.js';

export {
  deployInit,
  type DeployInitInput,
  type DeployInitResult,
  type DeployUpload,
} from './deploy-init.server.js';
export {
  deployCommit,
  type DeployCommitInput,
  type DeployCommitResult,
} from './deploy-commit.server.js';
export {
  deployStatus,
  type DeployStatusInput,
  type DeployStatusResult,
} from './deploy-status.server.js';
export {
  rollback,
  type RollbackInput,
  type RollbackResult,
} from './rollback.server.js';

export { publishDeployProgress, type DeployProgress } from './progress.server.js';
export {
  loadDeployView,
  progressFromView,
  createDeployEventStream,
  type DeployView,
} from './events.js';

export {
  getDeployQueue,
  enqueueDeploy,
  createBullConnection,
  closeDeployQueue,
} from './queue.server.js';
export {
  processDeployJob,
  createDeployWorker,
  dbOrphanSweepDeps,
  sweepOrphanBlobsFromDb,
  type ProcessDeployJob,
} from './worker.server.js';

export {
  getBlobStore,
  setBlobStoreForTests,
  presentShas,
  loadDeployRow,
  loadAppRow,
  loadAppBySlug,
} from './store.server.js';
export {
  writeAudit,
  actorKindForSurface,
  type AuditEntry,
  type AuditActorKind,
  type AuditSurface,
} from './audit.server.js';
export {
  pruneAuditLog,
  auditRetentionDays,
  type PruneAuditInput,
} from '@drobek/audit';
