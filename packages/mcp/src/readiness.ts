/**
 * The publish readiness report on the MCP tools (NSO-384): write_files runs it
 * over the files it just compiled, publish over the version it put live.
 * Blocking = compile errors (they already block today); warnings never stop a
 * write or a publish. A check or module-config load that fails is logged and
 * left out — the report never fails the tool.
 */
import { versionReadiness } from '@drobek/apps';
import { readinessLimitsFromEnv, readinessReport, type BlockingMessage, type ReadinessModule, type ReadinessOptions, type ReadinessReport } from '@drobek/compile';
import { dbErrorForLog } from '@drobek/db';
import type { ModuleRuntime } from '@drobek/modules';
import type { ToolDeps } from './context.js';

interface ReadinessCtx {
  deps: Pick<ToolDeps, 'env' | 'log'>;
  modules: Pick<ModuleRuntime, 'appModules'>;
}

function options(ctx: ReadinessCtx, appId: string, enabled: ReadonlySet<string>): Omit<ReadinessOptions, 'files' | 'blocking'> {
  return {
    limits: readinessLimitsFromEnv(ctx.deps.env),
    loadModules: async (): Promise<ReadinessModule[]> => {
      const states = await ctx.modules.appModules(appId, undefined, enabled);
      return Object.entries(states).map(([name, s]) => ({ name, enabled: s.enabled, config: s.config, pending: s.pending_confirmation }));
    },
    onCheckError: (check, err) => ctx.deps.log.warn('readiness check failed', { app_id: appId, check, error: dbErrorForLog(err) }),
  };
}

/**
 * write_files: the report of the files just compiled (`blocking` = the
 * result's compile errors). The type check (NSO-388) is still running then:
 * `typecheck: 'pending'`, and get_app has its `type_error` warnings later.
 */
export async function filesReadiness(
  ctx: ReadinessCtx,
  appId: string,
  enabled: ReadonlySet<string>,
  files: ReadonlyMap<string, string | Buffer>,
  blocking: readonly BlockingMessage[],
  typecheck?: 'pending'
): Promise<ReadinessReport> {
  const report = await readinessReport({ ...options(ctx, appId, enabled), files, blocking });
  return typecheck ? { ...report, typecheck } : report;
}

/** publish: the report of a stored version; undefined when it cannot be read (the publish already happened). */
export async function storedReadiness(
  ctx: ReadinessCtx,
  appId: string,
  enabled: ReadonlySet<string>,
  number: number
): Promise<ReadinessReport | undefined> {
  try {
    return (await versionReadiness(appId, { number }, options(ctx, appId, enabled)))?.report;
  } catch (err) {
    ctx.deps.log.warn('readiness report failed', { app_id: appId, version: number, error: dbErrorForLog(err) });
    return undefined;
  }
}
