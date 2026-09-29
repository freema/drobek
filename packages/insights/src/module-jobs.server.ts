/**
 * A failed run of a platform module's per-app job (NSO-391), stored with the
 * app's browser errors so get_logs `runtime` and the dashboard's Logs tab
 * show it: type `module_job`, the module and job, the redacted and truncated
 * message (a job's error can quote an upstream URL or a key) and an empty
 * page URL. No stack: it would name the server's files, not the app's. The
 * same dedup (per module, job and message) and ring buffer as the beacon's.
 */
import { appErrors, getDb } from '@drobek/db';
import { pruneAppErrors } from './beacon.server.js';
import { beaconLimitsFromEnv } from './limits.js';
import { MAX_MESSAGE, dedupKey, redact } from './sanitize.js';

export interface ModuleJobFailure {
  appId: string;
  module: string;
  job: string;
  message: string;
}

export async function recordModuleJobFailure(failure: ModuleJobFailure, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const redacted = redact(failure.message.trim());
  const message = (redacted.length > MAX_MESSAGE ? `${redacted.slice(0, MAX_MESSAGE)}…` : redacted) || 'the job failed';
  await getDb()
    .insert(appErrors)
    .values({
      appId: failure.appId,
      type: 'module_job',
      message,
      stack: null,
      url: '',
      dedupKey: dedupKey(`${failure.module}/${failure.job}: ${message}`, null),
      module: failure.module,
      job: failure.job,
    });
  await pruneAppErrors(failure.appId, beaconLimitsFromEnv(env));
}
