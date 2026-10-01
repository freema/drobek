/**
 * The module-jobs scheduler: runs the `jobs` of the active modules
 * (contract 1.2) in the server process, next to the other background sweeps.
 *
 * Every MODULE_JOBS_TICK_MS the scheduler looks at each job — a `server`
 * job once, an `app` job once per app of `ModuleRuntime.jobApps()` with the
 * interval its config gives — and starts the runs that are due:
 *
 *  - state per job (and app) in Redis, `drobek:modjob:<module>:<job>[:<app>]`
 *    = `{ lastRunAt, lastSuccessAt, failures }` (expires on its own, so the
 *    state of a deleted app goes away); due = lastRunAt + the interval, or
 *    after a failure + the backoff (1 min doubling per consecutive failure, at
 *    most max(interval, 1 h)); no state = due now;
 *  - a Redis lease per run (`drobek:lock:modjob:…`, the timeout + a minute)
 *    and a second look at the state under it, so a run happens once across
 *    replicas;
 *  - at most MODULE_JOBS_CONCURRENCY runs in flight per process (a due run
 *    past the cap waits for a later tick), each cut off at
 *    MODULE_JOBS_TIMEOUT_MS — its `signal` aborts and the run counts as
 *    failed; one that ignores the signal keeps the lease a minute longer and
 *    may then overlap the next run;
 *  - a failure is logged (module, job, app, failures, the retry delay) and,
 *    for an `app` job, stored in the app's get_logs `runtime`
 *    (@drobek/insights recordModuleJobFailure, redacted).
 *
 * Nothing here runs before the first tick, and a tick never throws: a job
 * cannot hold up the server's start or its requests. MODULE_JOBS_ENABLED=0
 * turns the scheduler off for this process.
 */
import { getRedis, reportError, type Logger } from '@drobek/core';
import { dbErrorForLog } from '@drobek/db';
import { recordModuleJobFailure, redact } from '@drobek/insights';
import { JOB_MAX_INTERVAL_MS, JOB_MIN_INTERVAL_MS, parseJobInterval, type AnyModule, type ModuleJob } from './contract.js';
import type { JobAppRow, JobRunInput, ModuleRuntime } from './runtime.js';

export const DEFAULT_MODULE_JOBS_CONCURRENCY = 4;
export const DEFAULT_MODULE_JOBS_TIMEOUT_MS = 5 * 60_000;
/** How often the scheduler looks for due runs. */
export const MODULE_JOBS_TICK_MS = 15_000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 60 * 60_000;
/** How long a timed-out run keeps its lease while it has not settled. */
const TIMEOUT_GRACE_MS = 60_000;
/** How long `stop()` waits for the runs in flight after aborting them. */
const STOP_WAIT_MS = 5_000;
const STATE_BATCH = 200;

export interface ModuleJobsSettings {
  /** MODULE_JOBS_ENABLED (default on; `0` or `false` = no job runs in this process). */
  enabled: boolean;
  /** MODULE_JOBS_CONCURRENCY: runs in flight per process. */
  concurrency: number;
  /** MODULE_JOBS_TIMEOUT_MS: the longest one run may take. */
  timeoutMs: number;
}

function intEnv(raw: string | undefined, fallback: number, name: string, warnings: string[]): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return n;
  warnings.push(`${name}=${JSON.stringify(raw)} is not a positive integer — using ${fallback}`);
  return fallback;
}

/** The operator's settings (production defaults for unset or invalid values, with a warning per invalid one). */
export function moduleJobsSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): { settings: ModuleJobsSettings; warnings: string[] } {
  const warnings: string[] = [];
  const raw = env.MODULE_JOBS_ENABLED?.trim().toLowerCase() ?? '';
  if (raw !== '' && !['0', '1', 'true', 'false'].includes(raw)) warnings.push(`MODULE_JOBS_ENABLED=${JSON.stringify(env.MODULE_JOBS_ENABLED)} is not 1 or 0 — jobs stay on`);
  return {
    settings: {
      enabled: raw !== '0' && raw !== 'false',
      concurrency: intEnv(env.MODULE_JOBS_CONCURRENCY, DEFAULT_MODULE_JOBS_CONCURRENCY, 'MODULE_JOBS_CONCURRENCY', warnings),
      timeoutMs: intEnv(env.MODULE_JOBS_TIMEOUT_MS, DEFAULT_MODULE_JOBS_TIMEOUT_MS, 'MODULE_JOBS_TIMEOUT_MS', warnings),
    },
    warnings,
  };
}

// ── state ────────────────────────────────────────────────────────────────────

export interface JobState {
  /** When the last run ended (epoch ms). */
  lastRunAt: number;
  /** When the last successful run started (epoch ms), or null. */
  lastSuccessAt: number | null;
  /** Failed runs since the last success. */
  failures: number;
}

export interface JobStateStore {
  read(keys: string[]): Promise<(JobState | null)[]>;
  write(key: string, state: JobState, ttlSec: number): Promise<void>;
}

function parseState(raw: string | null | undefined): JobState | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<JobState>;
    if (typeof o.lastRunAt !== 'number') return null;
    return {
      lastRunAt: o.lastRunAt,
      lastSuccessAt: typeof o.lastSuccessAt === 'number' ? o.lastSuccessAt : null,
      failures: typeof o.failures === 'number' && o.failures > 0 ? Math.floor(o.failures) : 0,
    };
  } catch {
    return null;
  }
}

type RedisLike = ReturnType<typeof getRedis>;

export function redisJobStateStore(redis: () => Pick<RedisLike, 'mget' | 'set'> = getRedis): JobStateStore {
  return {
    async read(keys) {
      if (keys.length === 0) return [];
      return (await redis().mget(...keys)).map(parseState);
    },
    async write(key, state, ttlSec) {
      await redis().set(key, JSON.stringify(state), 'EX', ttlSec);
    },
  };
}

/** In-memory state (tests; `now` decides expiry). */
export function memoryJobStateStore(now: () => number = Date.now): JobStateStore & { entries(): Map<string, JobState> } {
  const map = new Map<string, { state: JobState; until: number }>();
  const live = (key: string) => {
    const e = map.get(key);
    if (e && e.until <= now()) map.delete(key);
    return map.get(key)?.state ?? null;
  };
  return {
    async read(keys) {
      return keys.map(live);
    },
    async write(key, state, ttlSec) {
      map.set(key, { state: { ...state }, until: now() + ttlSec * 1000 });
    },
    entries() {
      return new Map([...map.keys()].filter((k) => live(k)).map((k) => [k, map.get(k)!.state]));
    },
  };
}

// ── timing ───────────────────────────────────────────────────────────────────

/** The delay before retrying after `failures` consecutive failures: 1 min, doubling, at most max(interval, 1 h). */
export function jobBackoffMs(failures: number, intervalMs: number): number {
  const cap = Math.max(intervalMs, BACKOFF_CAP_MS);
  return Math.min(cap, BACKOFF_BASE_MS * 2 ** Math.min(Math.max(failures, 1) - 1, 30));
}

/** When the next run is due (epoch ms; 0 = now). */
export function jobDueAt(state: JobState | null, intervalMs: number): number {
  if (!state) return 0;
  return state.lastRunAt + (state.failures > 0 ? jobBackoffMs(state.failures, intervalMs) : intervalMs);
}

function stateTtlSec(intervalMs: number): number {
  return Math.ceil((2 * Math.max(intervalMs, BACKOFF_CAP_MS) + 86_400_000) / 1000);
}

export function jobStateKey(module: string, job: string, appId?: string): string {
  return `drobek:modjob:${module}:${job}${appId ? `:${appId}` : ''}`;
}

// ── the scheduler ────────────────────────────────────────────────────────────

/** Run `fn` while holding a lease; `{ acquired: false }` when another replica holds it. */
export type JobLease = <T>(key: string, ttlSec: number, fn: () => Promise<T>) => Promise<{ acquired: true; result: T } | { acquired: false }>;

export interface ModuleJobFailureRecord {
  appId: string;
  module: string;
  job: string;
  message: string;
}

export interface ModuleJobSchedulerOptions {
  runtime: Pick<ModuleRuntime, 'modules' | 'jobApps' | 'serverJobContext' | 'appJobContext'>;
  lease: JobLease;
  state?: JobStateStore;
  log: Logger;
  settings?: ModuleJobsSettings;
  /** Store a per-app job's failure for get_logs (default: @drobek/insights). */
  recordFailure?: (failure: ModuleJobFailureRecord) => Promise<void>;
  now?: () => number;
}

class JobTimeoutError extends Error {
  constructor(ms: number) {
    super(`the run took longer than MODULE_JOBS_TIMEOUT_MS (${ms} ms) and was aborted`);
    this.name = 'JobTimeoutError';
  }
}

interface Due {
  key: string;
  module: AnyModule;
  job: ModuleJob;
  intervalMs: number;
  row: JobAppRow | null;
}

export class ModuleJobScheduler {
  private readonly settings: ModuleJobsSettings;
  private readonly state: JobStateStore;
  private readonly now: () => number;
  private readonly recordFailure: (failure: ModuleJobFailureRecord) => Promise<void>;
  /** Job (and app) keys with a run in flight in this process. */
  private readonly running = new Set<string>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  /** (job key, interval value) pairs already warned about. */
  private readonly warned = new Set<string>();
  private slots = 0;
  private ticking = false;
  private stopped = false;

  constructor(private readonly opts: ModuleJobSchedulerOptions) {
    this.settings = opts.settings ?? moduleJobsSettingsFromEnv().settings;
    this.state = opts.state ?? redisJobStateStore();
    this.now = opts.now ?? Date.now;
    this.recordFailure = opts.recordFailure ?? ((f) => recordModuleJobFailure(f));
  }

  /** Does any active module declare a job? */
  hasJobs(): boolean {
    return this.opts.runtime.modules.some((m) => (m.jobs?.length ?? 0) > 0);
  }

  /** Runs in flight in this process. */
  get active(): number {
    return this.slots;
  }

  /** Start the due runs (never throws; a tick still running makes this one a no-op). */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped || !this.settings.enabled) return;
    this.ticking = true;
    try {
      for (const m of this.opts.runtime.modules) {
        for (const job of m.jobs ?? []) {
          if (this.slots >= this.settings.concurrency) return;
          try {
            if (job.scope === 'app') await this.scheduleAppJob(m, job);
            else await this.scheduleServerJob(m, job);
          } catch (err) {
            this.opts.log.error('module job scheduling failed', { module: m.name, job: job.name, error: dbErrorForLog(err) });
          }
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Wait until every run started so far has settled (tests). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /** Stop starting runs, abort the ones in flight and wait for them a little. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const c of this.controllers) c.abort(new Error('the server is shutting down'));
    if (this.inflight.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.inflight]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STOP_WAIT_MS);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
  }

  private async scheduleServerJob(m: AnyModule, job: ModuleJob): Promise<void> {
    const intervalMs = parseJobInterval(job.every);
    if (intervalMs === null) return;
    const key = jobStateKey(m.name, job.name);
    if (this.running.has(key)) return;
    const [state] = await this.state.read([key]);
    if (this.now() >= jobDueAt(state ?? null, intervalMs)) this.launch({ key, module: m, job, intervalMs, row: null });
  }

  private async scheduleAppJob(m: AnyModule, job: ModuleJob): Promise<void> {
    let batch: Due[] = [];
    const flush = async (): Promise<boolean> => {
      const states = await this.state.read(batch.map((d) => d.key));
      const now = this.now();
      for (let i = 0; i < batch.length; i++) {
        if (this.slots >= this.settings.concurrency) return false;
        if (now >= jobDueAt(states[i] ?? null, batch[i].intervalMs)) this.launch(batch[i]);
      }
      batch = [];
      return true;
    };
    for await (const row of this.opts.runtime.jobApps(m)) {
      const key = jobStateKey(m.name, job.name, row.app.id);
      if (this.running.has(key)) continue;
      const intervalMs = this.appInterval(m, job, row, key);
      if (intervalMs === null) continue;
      batch.push({ key, module: m, job, intervalMs, row });
      if (batch.length >= STATE_BATCH && !(await flush())) return;
    }
    if (batch.length > 0) await flush();
  }

  /** An app job's interval for one app (clamped to the contract's range), or null: not for this app now. */
  private appInterval(m: AnyModule, job: ModuleJob, row: JobAppRow, key: string): number | null {
    let value: unknown = job.every;
    if (typeof job.every === 'function') {
      try {
        value = job.every(row.config as never, row.app);
      } catch (err) {
        this.warnOnce(`${key}:throw`, 'module job every() failed — the job does not run for this app', {
          module: m.name,
          job: job.name,
          app_id: row.app.id,
          error: dbErrorForLog(err),
        });
        return null;
      }
    }
    if (value === null || value === undefined) return null;
    const ms = parseJobInterval(value);
    if (ms === null) {
      this.warnOnce(`${key}:${String(value)}`, 'module job every() returned no valid interval — the job does not run for this app', {
        module: m.name,
        job: job.name,
        app_id: row.app.id,
        every: String(value).slice(0, 40),
      });
      return null;
    }
    return Math.min(JOB_MAX_INTERVAL_MS, Math.max(JOB_MIN_INTERVAL_MS, ms));
  }

  private warnOnce(key: string, message: string, meta: Record<string, unknown>): void {
    if (this.warned.has(key)) return;
    if (this.warned.size > 10_000) this.warned.clear();
    this.warned.add(key);
    this.opts.log.warn(message, meta);
  }

  private launch(due: Due): void {
    this.slots++;
    this.running.add(due.key);
    const released = { slot: false };
    const freeSlot = () => {
      if (released.slot) return;
      released.slot = true;
      this.slots--;
    };
    const p = this.execute(due, freeSlot)
      .catch((err: unknown) => {
        this.opts.log.error('module job could not run', { module: due.module.name, job: due.job.name, error: dbErrorForLog(err) });
        void reportError({
          message: 'module job could not run',
          error: err,
          context: { kind: 'module_job', module: due.module.name, job: due.job.name, ...(due.row ? { appId: due.row.app.id, workspaceId: due.row.app.workspaceId } : {}) },
        });
      })
      .finally(() => {
        freeSlot();
        this.running.delete(due.key);
        this.inflight.delete(p);
      });
    this.inflight.add(p);
  }

  private async execute(due: Due, freeSlot: () => void): Promise<void> {
    const { module: m, job, key, intervalMs, row } = due;
    const timeoutMs = this.settings.timeoutMs;
    const ttl = stateTtlSec(intervalMs);
    await this.opts.lease(`drobek:lock:modjob:${key.slice('drobek:modjob:'.length)}`, Math.ceil((timeoutMs + TIMEOUT_GRACE_MS) / 1000) + 60, async () => {
      const [current] = await this.state.read([key]);
      const state = current ?? null;
      if (this.stopped || this.now() < jobDueAt(state, intervalMs)) return;
      const startedAt = this.now();
      const controller = new AbortController();
      this.controllers.add(controller);
      const input: JobRunInput = {
        job: job.name,
        signal: controller.signal,
        lastSuccessAt: state?.lastSuccessAt ? new Date(state.lastSuccessAt) : null,
      };
      const work = (async () => {
        if (job.scope === 'app') {
          const ctx = await this.opts.runtime.appJobContext(m, row!, input);
          await job.run(ctx as never);
        } else {
          const ctx = this.opts.runtime.serverJobContext(m, input);
          await (job.run as (c: typeof ctx) => unknown)(ctx);
        }
      })();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const err = new JobTimeoutError(timeoutMs);
          controller.abort(err);
          reject(err);
        }, timeoutMs);
        timer.unref?.();
      });
      let failed: unknown = null;
      try {
        await Promise.race([work, timeout]);
      } catch (err) {
        failed = err ?? new Error('the job failed');
      } finally {
        clearTimeout(timer);
        this.controllers.delete(controller);
      }
      const meta = { module: m.name, job: job.name, ...(row ? { app_id: row.app.id } : {}) };
      if (failed === null) {
        await this.state.write(key, { lastRunAt: this.now(), lastSuccessAt: startedAt, failures: 0 }, ttl);
        this.opts.log.debug('module job ran', { ...meta, duration_ms: this.now() - startedAt });
      } else {
        const failures = (state?.failures ?? 0) + 1;
        await this.state.write(key, { lastRunAt: this.now(), lastSuccessAt: state?.lastSuccessAt ?? null, failures }, ttl);
        this.opts.log.error('module job failed', {
          ...meta,
          failures,
          retry_in_ms: jobBackoffMs(failures, intervalMs),
          error: redact(dbErrorForLog(failed, { stack: true })),
        });
        void reportError({
          message: 'module job failed',
          error: failed,
          context: { kind: 'module_job', module: m.name, job: job.name, ...(row ? { appId: row.app.id, workspaceId: row.app.workspaceId } : {}) },
        });
        if (row) {
          await this.recordFailure({ appId: row.app.id, module: m.name, job: job.name, message: dbErrorForLog(failed) }).catch((err: unknown) =>
            this.opts.log.error('module job failure could not be stored for get_logs', { ...meta, error: dbErrorForLog(err) })
          );
        }
      }
      freeSlot();
      if (failed instanceof JobTimeoutError) {
        // Keep the lease while the aborted run winds down, at most a minute.
        let grace: NodeJS.Timeout | undefined;
        await Promise.race([
          work.catch(() => undefined),
          new Promise<void>((resolve) => {
            grace = setTimeout(resolve, TIMEOUT_GRACE_MS);
            grace.unref?.();
          }),
        ]);
        clearTimeout(grace);
      }
    });
  }
}

/**
 * The scheduler in the server process: a tick every MODULE_JOBS_TICK_MS (the
 * first one a tick after the start), nothing at all when no active module
 * declares a job or MODULE_JOBS_ENABLED=0. Returns a stop function.
 */
export function startModuleJobs(opts: Omit<ModuleJobSchedulerOptions, 'settings'> & { env?: NodeJS.ProcessEnv; tickMs?: number }): () => Promise<void> {
  const { settings, warnings } = moduleJobsSettingsFromEnv(opts.env);
  for (const w of warnings) opts.log.warn(w);
  const scheduler = new ModuleJobScheduler({ ...opts, settings });
  if (!scheduler.hasJobs()) return async () => {};
  if (!settings.enabled) {
    opts.log.info('module jobs are off on this process (MODULE_JOBS_ENABLED=0)');
    return async () => {};
  }
  const timer = setInterval(() => void scheduler.tick(), opts.tickMs ?? MODULE_JOBS_TICK_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await scheduler.stop();
  };
}
