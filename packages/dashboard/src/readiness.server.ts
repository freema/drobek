/**
 * The publish readiness report of an app's newest version for the app page
 * — the same report write_files and publish give the agent. Best
 * effort: a failure shows "could not be loaded", never a 500, and never stops
 * a publish.
 */
import { versionReadiness } from '@drobek/apps';
import { readinessLimitsFromEnv, type ReadinessReport } from '@drobek/compile';
import { createConsoleLogger } from '@drobek/core';
import { dbErrorForLog } from '@drobek/db';
import { moduleRuntime } from '@drobek/modules';

export type ReadinessView =
  | { state: 'ok'; version: number; report: ReadinessReport }
  | { state: 'error'; version: number };

const log = createConsoleLogger('dashboard');

export async function loadReadiness(app: { id: string; workspaceId: string }, version: number): Promise<ReadinessView> {
  try {
    const got = await versionReadiness(
      app.id,
      { number: version },
      {
        limits: readinessLimitsFromEnv(process.env),
        loadModules: async () => {
          const runtime = await moduleRuntime();
          const states = await runtime.appModules(app.id);
          return Object.entries(states).map(([name, s]) => ({ name, enabled: s.enabled, config: s.config, pending: s.pending_confirmation }));
        },
        onCheckError: (check, err) => log.warn('readiness check failed', { app_id: app.id, check, error: dbErrorForLog(err) }),
      }
    );
    return got ? { state: 'ok', version: got.version, report: got.report } : { state: 'error', version };
  } catch (err) {
    log.warn('readiness report failed', { app_id: app.id, version, error: dbErrorForLog(err) });
    return { state: 'error', version };
  }
}
