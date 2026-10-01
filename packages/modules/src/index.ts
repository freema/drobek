/**
 * @drobek/modules — the platform module contract and runtime.
 *
 * A module is PLATFORM code the operator installs (`DROBEK_MODULES`): server
 * routes under `/__drobek/v1/<module>/…` on the app hosts, a slice of the
 * browser SDK (`import { drobek } from 'drobek'`), a per-app config the agent
 * sets with `configure_module`, and a skill the agent reads with `skill_info`.
 * App code is never executed by the server — only modules are.
 *
 * This entry is the in-repo surface: the public contract (public.ts, what
 * the npm package publishes) plus the runtime, registry and loader the
 * server wires together. Module authors use the contract and
 * `@drobek/modules/testing`; the contract is docs/MODULES.md.
 */
export * from './public.js';
export { selectEmailTransport } from './email-transport-slot.js';
export { selectErrorReporter } from './error-reporter-slot.js';
export { ModuleLoadError } from './errors.js';
export { mergePatch, jsonEqual } from './merge-patch.js';
export { Lru, jsonKey, stableJson } from './memo.js';
export {
  CORE_LIMITS,
  LIMITS_CACHE_TTL_SEC,
  LIMITS_SIGNATURE_HEADER,
  LIMITS_TIMESTAMP_HEADER,
  createLimitsProvider,
  limitsProviderConfigError,
  moduleEnabledLimitName,
  signLimitsRequest,
  type LimitsProvider,
} from './limits.js';
export {
  END_USER_COOKIE,
  END_USER_COOKIE_INSECURE,
  END_USER_SESSION_TTL_SEC,
  END_USER_TOKEN_RE,
  cookiePrincipalResolver,
  createEndUserSession,
  destroyEndUserSession,
  endUserCookieHeader,
  endUserCookieName,
  endUserCookiesSecure,
  endUserEpochKey,
  endUserSessionKey,
  loadEndUserSession,
  parseEndUserSession,
  readEndUserToken,
  renewEndUserSession,
  revokeEndUserSessions,
  type EndUserRedis,
  type CurrentEndUser,
  type EndUserSession,
  type PrincipalResolver,
} from './principal.js';
export { SECRET_NAME_RE, SECRET_MAX_BYTES, SecretStoreError, deleteModuleSecret, getModuleSecret, secretsSet, secretsStatus, setModuleSecret } from './secrets.server.js';
export { readConfigRow, type ConfigRow, type PendingChange } from './configs.server.js';
export { PENDING_MAIL_WINDOW_MS, pendingMail, pendingMailKey, type PendingMail, type PendingMailModule } from './pending-mail.js';
export {
  BACKEND_IMPORT_SKILLS,
  PLATFORM_SKILL_NAME,
  generalSkillsDir,
  loadGeneralSkills,
  parseSkillMarkdown,
  skillForImport,
  type SkillEntry,
} from './skills.js';
export {
  BEACON_SCRIPT_PATH,
  SDK_PATH,
  SDK_TYPES_PATH,
  buildBeaconScript,
  buildSdk,
  inlineSpecifier,
  sdkDeclarations,
  type BeaconScript,
  type SdkBundle,
} from './sdk-build.js';
export { EMAIL_RE, MAX_EMAIL_TEXT, capEmailText, emailKind, recipientRefs, resolveRecipients, sanitizeSubject, type RecipientSources } from './email.js';
export {
  MAIL_COUNTER_KEYS,
  MAIL_PAUSE_KEYS,
  mailAppCounterKey,
  mailBudgets,
  mailGuardConfigFromEnv,
  memoryMailGuard,
  memoryMailGuardRedis,
  redisMailGuard,
  type MailBudgets,
  type MailClass,
  type MailGuard,
  type MailGuardConfig,
  type MailGuardMeta,
  type MailGuardRedis,
} from './mail-guard.js';
export { MAX_FILE_HEAD_BYTES, multipartBoundary, parseMultipart, streamMultipartFile } from './multipart.js';
export { SDK_HEADER, DEFAULT_MAX_BODY_BYTES, isReadable, type PipelineRequest, type PipelineResult } from './router.js';
export { csvChunks } from './csv-stream.js';
export {
  RESERVED_MODULE_NAMES,
  checkErrorCodes,
  checkModuleSet,
  checkRequires,
  collectContributions,
  composeModule,
  effectiveConfigDefaults,
  moduleDefaultsEnvName,
  endUserAuthorityOf,
  mailAuthorityOf,
  recordsAuthorityOf,
  submissionsAuthorityOf,
  filesAuthorityOf,
  syncAuthorityOf,
  upstreamsAuthorityOf,
  loadModules,
  loadModuleSet,
  packageNameFor,
  parseModuleList,
  type LoadedModules,
  type ModuleOrigin,
  type ModuleSource,
  type SlotContribution,
} from './registry.js';
export { DEFAULT_MODULES_DIR } from './dir-modules.js';
// The module configs of a duplicated gallery app, proposed through the copy's confirmation flow.
export {
  NOT_COPIED_MODULES,
  configForCopy,
  duplicateModuleConfigs,
  type DuplicateConfigsInput,
  type DuplicateConfigsResult,
} from './duplicate.js';
export {
  ModuleRuntime,
  activeModules,
  appOwnerEmails,
  confirmUrl,
  loadModuleRuntime,
  memoryRateLimiter,
  moduleJournalTable,
  moduleRuntime,
  redisRateLimiter,
  setModuleRuntimeForTests,
  smtpEmailTransport,
  type AppModuleState,
  type BoundEndUsers,
  type BoundFiles,
  type BoundRecords,
  type BoundSubmissions,
  type BoundSync,
  type RunActor,
  type ConfigureInput,
  type ConfigureResult,
  type DecisionInput,
  type EmailTransport,
  type JobAppRow,
  type JobRunInput,
  type ModuleDashboardView,
  type PendingView,
  type PlatformMailParts,
  type TransportMessage,
  type LoadRuntimeOptions,
  type ModuleErrorSection,
  type ModuleSummary,
  type ModuleFacts,
  type PlatformApp,
  type PlatformRequest,
  type RateLimiter,
  type RuntimeDeps,
  type SkillInfo,
  type SkillJob,
  type SkillListItem,
  type WorkspaceModuleSource,
  type WorkspaceModuleState,
} from './runtime.js';
export {
  DEFAULT_MODULE_JOBS_CONCURRENCY,
  DEFAULT_MODULE_JOBS_TIMEOUT_MS,
  MODULE_JOBS_TICK_MS,
  ModuleJobScheduler,
  jobBackoffMs,
  jobDueAt,
  jobStateKey,
  memoryJobStateStore,
  moduleJobsSettingsFromEnv,
  redisJobStateStore,
  startModuleJobs,
  type JobLease,
  type JobState,
  type JobStateStore,
  type ModuleJobFailureRecord,
  type ModuleJobSchedulerOptions,
  type ModuleJobsSettings,
} from './jobs.js';
