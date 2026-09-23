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
  type DrobekModule,
  type EmailMessage,
  type EmailRecipient,
  type HookApp,
  type Limits,
  type ModuleContext,
  type ModuleHooks,
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
  cookiePrincipalResolver,
  endUserCookieName,
  endUserCookiesSecure,
  endUserSessionKey,
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
export { SDK_PATH, SDK_TYPES_PATH, buildSdk, sdkDeclarations, type SdkBundle } from './sdk-build.js';
export { SDK_HEADER, DEFAULT_MAX_BODY_BYTES, type PipelineRequest, type PipelineResult } from './router.js';
export {
  BUILTIN_MODULES,
  ModuleLoadError,
  RESERVED_MODULE_NAMES,
  loadModules,
  packageNameFor,
  parseModuleList,
} from './registry.js';
export {
  ModuleRuntime,
  confirmUrl,
  loadModuleRuntime,
  memoryRateLimiter,
  moduleJournalTable,
  moduleRuntime,
  redisRateLimiter,
  setModuleRuntimeForTests,
  smtpEmailTransport,
  type AppModuleState,
  type ConfigureInput,
  type ConfigureResult,
  type DecisionInput,
  type EmailTransport,
  type LoadRuntimeOptions,
  type PlatformApp,
  type PlatformRequest,
  type RateLimiter,
  type RuntimeDeps,
  type SkillInfo,
  type SkillListItem,
} from './runtime.js';
