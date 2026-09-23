/**
 * @drobek/modules — the platform module contract and runtime (M1-01).
 *
 * A module is PLATFORM code the operator installs (`DROBEK_MODULES`): server
 * routes under `/__drobek/v1/<module>/…` on the app hosts, a slice of the
 * browser SDK (`import { drobek } from 'drobek'`), a per-app config the agent
 * sets with `configure_module`, and a skill the agent reads with `skill_info`.
 * App code is never executed by the server — only modules are.
 *
 * Module authors: `defineModule`, `z`, `respond`, `ModuleError` (+ types);
 * tests: `@drobek/modules/testing`. The contract is docs/MODULES.md.
 */
export { z } from 'zod';
export {
  MODULE_CONTRACT_VERSION,
  MODULE_NAME_RE,
  defineModule,
  isDefinedModule,
  respond,
  type AccessDecision,
  type AnyModule,
  type ConfirmContext,
  type DrobekModule,
  type EmailKind,
  type EmailMessage,
  type EmailRecipient,
  type EndUser,
  type EndUserAuthority,
  type HookApp,
  type Limits,
  type MailAuthority,
  type MailEnvelope,
  type MailPrepareInput,
  type ModuleContext,
  type ModuleHooks,
  type ModuleAppView,
  type ModuleLimit,
  type ModuleMigrations,
  type ModuleRequest,
  type ModuleResponse,
  type ModuleRouter,
  type ModuleSdk,
  type ModuleSecretDoc,
  type ModuleServices,
  type ModuleSkill,
  type Principal,
  type RateLimitResult,
  type RecordsAuthority,
  type RecordsCollection,
  type RecordsPage,
  type RecordsQuery,
  type RecordsView,
  type RouteHandler,
  type RouteOptions,
  type RouteRateLimit,
  type Rule,
} from './contract.js';
export { MODULE_ERROR_CODES, ModuleError, isModuleError, skillHint, issuePaths, type ModuleErrorBody, type ModuleErrorCode } from './errors.js';
export { RULE_TOKENS, decideAccess, isValidRule, parseRule, ruleIsPublic } from './rules.js';
export { mergePatch, jsonEqual } from './merge-patch.js';
export {
  LIMITS_CACHE_TTL_SEC,
  LIMITS_SIGNATURE_HEADER,
  LIMITS_TIMESTAMP_HEADER,
  createLimitsProvider,
  limitsProviderConfigError,
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
export { SECRET_NAME_RE, SecretStoreError, deleteModuleSecret, getModuleSecret, secretsSet, setModuleSecret } from './secrets.server.js';
export { readConfigRow, type ConfigRow, type PendingChange } from './configs.server.js';
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
export { multipartBoundary, parseMultipart } from './multipart.js';
export { SDK_HEADER, DEFAULT_MAX_BODY_BYTES, type PipelineRequest, type PipelineResult } from './router.js';
export {
  ModuleLoadError,
  RESERVED_MODULE_NAMES,
  checkRequires,
  endUserAuthorityOf,
  mailAuthorityOf,
  recordsAuthorityOf,
  loadModules,
  packageNameFor,
  parseModuleList,
} from './registry.js';
export {
  ModuleRuntime,
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
  type BoundRecords,
  type ConfigureInput,
  type ConfigureResult,
  type DecisionInput,
  type EmailTransport,
  type TransportMessage,
  type LoadRuntimeOptions,
  type PlatformApp,
  type PlatformRequest,
  type RateLimiter,
  type RuntimeDeps,
  type SkillInfo,
  type SkillListItem,
} from './runtime.js';
