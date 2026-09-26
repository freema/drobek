/**
 * Who is calling (resolved by the MCP resource server from the Bearer) and the
 * side-effect seams the tools use (lease store, change notifications, compiler,
 * clock) — injectable so unit tests run without Redis and without sleeping.
 */
import { assetDisk, assetUploadAllowed, notifyAppChanged, redisUploadTokenStore, type AppChangedEvent } from '@drobek/apps';
import { Compiler, type CompileOptions, type SourceFiles } from '@drobek/compile';
import { createConsoleLogger, getRedis, type Logger } from '@drobek/core';
import {
  queryCompileLog,
  queryRequestLog,
  queryRuntimeLog,
  recordCompile,
  type CompileEntry,
  type RecordCompileInput,
  type RequestsEntry,
  type RuntimeEntry,
} from '@drobek/insights';
import { moduleRuntime, type ModuleRuntime } from '@drobek/modules';
import type { AssetDeps } from './assets.js';
import { redisLeaseStore, type LeaseStore } from './lease.js';

export { APP_CHANGED_CHANNEL, type AppChangedEvent } from '@drobek/apps';

/** The authenticated principal of one MCP session (a user-bound grant). */
export interface ToolPrincipal {
  userId: string;
  email: string;
  /** Global SUPERADMIN_EMAIL override: reaches every workspace. */
  superAdmin: boolean;
}

/**
 * get_logs storage (M1-07): the compile history written by create_app /
 * write_files and the three read kinds. The default is @drobek/insights over
 * Postgres (+ Redis for the daily serving counters).
 */
export interface LogStore {
  recordCompile(input: RecordCompileInput): Promise<void>;
  runtime(appId: string, since: Date): Promise<RuntimeEntry[]>;
  compile(appId: string, since: Date): Promise<CompileEntry[]>;
  requests(appId: string, since: Date): Promise<RequestsEntry[]>;
}

/** The @drobek/insights LogStore. `flushSignals: false` skips Redis (tests). */
export function insightsLogStore(opts: { flushSignals?: boolean } = {}): LogStore {
  return {
    recordCompile: (input) => recordCompile(input),
    runtime: (appId, since) => queryRuntimeLog(appId, since),
    compile: (appId, since) => queryCompileLog(appId, since),
    requests: (appId, since) => queryRequestLog(appId, since, { flush: opts.flushSignals !== false }),
  };
}

export interface ToolDeps {
  leases: LeaseStore;
  /** Cache bust for the app hosts — best effort, never fails a write. */
  notifyAppChanged: (event: AppChangedEvent) => Promise<void>;
  compile: (files: SourceFiles, opts?: CompileOptions) => ReturnType<Compiler['compile']>;
  /** Live compile limits (the tools pre-check sizes with them, the briefing states them). */
  limits: Compiler['limits'];
  now: () => number;
  env: NodeJS.ProcessEnv;
  log: Logger;
  /** The process's platform modules + skills (M1-01): skill_info, configure_module, get_app.modules. */
  modules: () => Promise<ModuleRuntime>;
  /** Compile history + get_logs reads (M1-07). */
  logs: LogStore;
  /** Upload tokens, the hourly upload-URL budget and the asset disk (NSO-358). */
  assets: AssetDeps;
}

let sharedCompiler: Compiler | null = null;

function defaultCompiler(): Compiler {
  sharedCompiler ??= new Compiler();
  return sharedCompiler;
}

/** Production deps: Redis-backed lease + pub/sub, the process-wide compiler. */
export function defaultDeps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  const log = overrides.log ?? createConsoleLogger('mcp');
  return {
    leases: redisLeaseStore(() => getRedis(), overrides.now),
    notifyAppChanged: (event) => notifyAppChanged(event, log),
    compile: (files, opts) => defaultCompiler().compile(files, opts),
    get limits() {
      return defaultCompiler().limits;
    },
    now: Date.now,
    env: process.env,
    log,
    modules: () => moduleRuntime(),
    logs: insightsLogStore(),
    assets: {
      tokens: redisUploadTokenStore(),
      uploadAllowed: (appId) => assetUploadAllowed(appId),
      disk: assetDisk(),
    },
    ...overrides,
  };
}
