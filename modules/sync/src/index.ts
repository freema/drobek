/**
 * drobek-module-sync — the BUILT-IN platform module `sync`: an app
 * keeps a data collection filled from an external API on a schedule, without
 * running any app code and without the API key ever leaving the dashboard.
 *
 *   DROBEK_MODULES=…,proxy,data,sync  → this package (`modules/sync` in the
 *                                       drobek repo, a dependency of the server).
 *
 *   config { sources: { <name>: { upstream, path, method, every, collection, items, key?, mode, paused? } } }
 *
 * A source names an upstream assigned to the app in the proxy config and a
 * collection declared in the data config; the app reads the collection with
 * `drobek.data`. The module has no routes and no SDK: its app job (contract
 * 1.2, every minute while the app has a source) runs the due sources through
 * `ctx.upstreams.fetch` and `ctx.records.import` (run.ts). The `sync`
 * authority gives the owner the sources' state, the run history, Run now and
 * Resume (the dashboard module page, MCP `sync_now`, get_logs `sync`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineModule, type SyncAuthority } from '@drobek/modules';
import {
  DEFAULT_MAX_RECORDS_PER_RUN,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_SOURCES_PER_APP,
  DEFAULT_MIN_INTERVAL_MIN,
  DEFAULT_NOW_PER_MINUTE,
  DEFAULT_PAUSE_AFTER_FAILURES,
  DEFAULT_RUNS_PER_HOUR_PER_APP,
  SYNC_CONFIG_DEFAULTS,
  syncConfigSchema,
  syncConfirmRequiredIn,
  syncLimits,
  type SyncConfig,
} from './config.js';
import { forgetApp, recentRuns, resumeSource, runDueSources, runNow, sourceStates } from './run.js';

export {
  DEFAULT_MAX_RECORDS_PER_RUN,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_SOURCES_PER_APP,
  DEFAULT_MIN_INTERVAL_MIN,
  DEFAULT_NOW_PER_MINUTE,
  DEFAULT_PAUSE_AFTER_FAILURES,
  DEFAULT_RUNS_PER_HOUR_PER_APP,
  SYNC_CONFIG_DEFAULTS,
  effectiveIntervalMs,
  sourceHash,
  syncConfigSchema,
  syncConfirmRequired,
  syncConfirmRequiredIn,
  syncLimits,
  type SyncConfig,
  type SyncSource,
} from './config.js';
export { SyncRunError, itemsPath, pickRecords } from './items.js';
export { RUNS_KEPT, backoffMs, runDueSources, runNow, runSource, sourceStates } from './run.js';
export { syncRuns, syncSources } from './schema.js';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** How often the app job looks for due sources (each source runs on its own interval). */
const PASS_EVERY = '1m';

const authority: SyncAuthority<SyncConfig> = {
  async sources(view) {
    return sourceStates(view, syncLimits(await view.limits()));
  },
  runs: (view, q) => recentRuns(view.db, view.app.id, q),
  runNow: (ctx, source) => runNow(ctx, source),
  resume: (view, source) => resumeSource(view, source),
};

const sync = defineModule<SyncConfig>({
  name: 'sync',
  version: '1.0.0',
  contract: '^1.2',
  requires: ['proxy', 'data'],
  skill: {
    useWhen:
      'the app shows data from an external API that should refresh on its own (scores, prices, schedules, a feed) — drobek fetches it on a schedule into a data collection; the key stays in the dashboard',
    markdown: readFileSync(here('../SKILL.md'), 'utf8'),
  },
  configSchema: syncConfigSchema,
  configDefaults: SYNC_CONFIG_DEFAULTS,
  confirmRequired: syncConfirmRequiredIn,
  limits: [
    { env: 'SYNC_MIN_INTERVAL_MIN', default: DEFAULT_MIN_INTERVAL_MIN, meaning: 'the shortest interval of a sync source, in minutes' },
    { env: 'SYNC_MAX_SOURCES_PER_APP', default: DEFAULT_MAX_SOURCES_PER_APP, meaning: 'sync sources one app may have' },
    { env: 'SYNC_MAX_RESPONSE_BYTES', default: DEFAULT_MAX_RESPONSE_BYTES, meaning: 'bytes of one upstream answer a sync run reads (PROXY_MAX_RESPONSE_BYTES caps it too)' },
    { env: 'SYNC_MAX_RECORDS_PER_RUN', default: DEFAULT_MAX_RECORDS_PER_RUN, meaning: 'records one sync run may import' },
    { env: 'SYNC_RUNS_PER_HOUR_PER_APP', default: DEFAULT_RUNS_PER_HOUR_PER_APP, meaning: 'sync runs (scheduled and by hand) one app may make per hour' },
    { env: 'SYNC_PAUSE_AFTER_FAILURES', default: DEFAULT_PAUSE_AFTER_FAILURES, meaning: 'failed runs in a row after which a sync source pauses' },
    { env: 'SYNC_NOW_PER_MINUTE', default: DEFAULT_NOW_PER_MINUTE, meaning: 'runs by hand (Run now, sync_now) of one source per minute' },
  ],
  jobs: [
    {
      name: 'sources',
      scope: 'app',
      description: 'runs the app\'s due sync sources (each on its own interval, at least SYNC_MIN_INTERVAL_MIN minutes)',
      every: (config) => (Object.keys(config.sources).length > 0 ? PASS_EVERY : null),
      run: (ctx) => runDueSources(ctx),
    },
  ],
  sync: authority,
  appInfo: async (view) => {
    const sources = await sourceStates(view, syncLimits({}));
    return {
      sources: sources.map((s) => ({
        name: s.name,
        paused: s.paused,
        failures: s.failures,
        last_run_at: s.last_run_at,
        last_status: s.last_status,
        last_records: s.last_records,
        last_error: s.last_error,
      })),
    };
  },
  hooks: {
    onAppDelete: (app, services) => forgetApp(services.db, app.id),
  },
  migrations: { folder: here('../migrations') },
});

export default sync;
