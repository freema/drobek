/**
 * Who is calling (resolved by the MCP resource server from the Bearer) and the
 * side-effect seams the tools use (lease store, change notifications, compiler,
 * clock) — injectable so unit tests run without Redis and without sleeping.
 */
import { notifyAppChanged, type AppChangedEvent } from '@drobek/apps';
import { Compiler, type CompileOptions, type SourceFiles } from '@drobek/compile';
import { createConsoleLogger, getRedis, type Logger } from '@drobek/core';
import { moduleRuntime, type ModuleRuntime } from '@drobek/modules';
import { redisLeaseStore, type LeaseStore } from './lease.js';

export { APP_CHANGED_CHANNEL, type AppChangedEvent } from '@drobek/apps';

/** The authenticated principal of one MCP session (a user-bound grant). */
export interface ToolPrincipal {
  userId: string;
  email: string;
  /** Global SUPERADMIN_EMAIL override: reaches every workspace. */
  superAdmin: boolean;
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
    ...overrides,
  };
}
