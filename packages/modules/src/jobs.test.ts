/**
 * The module-jobs scheduler over a fake runtime, in-memory state and
 * an in-memory lease shared like Redis would be between replicas: when a run
 * is due, once across replicas, backoff after a failure, per-app intervals
 * from the config, the concurrency cap, the timeout, and that nothing ever
 * throws out of a tick.
 */
import { describe, expect, it, vi } from 'vitest';
import { installErrorReporter, noopLogger, resetErrorReporterForTests, type ErrorReportEvent } from '@drobek/core';
import { z } from 'zod';
import { defineModule, type AnyModule, type AppJobContext, type HookApp, type ModuleJob, type ServerJobContext } from './contract.js';
import {
  ModuleJobScheduler,
  jobBackoffMs,
  jobDueAt,
  jobStateKey,
  memoryJobStateStore,
  moduleJobsSettingsFromEnv,
  startModuleJobs,
  type JobLease,
  type JobStateStore,
  type ModuleJobFailureRecord,
} from './jobs.js';
import type { JobAppRow, JobRunInput } from './runtime.js';

const MIN = 60_000;

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A lease every scheduler of a test shares — two schedulers = two replicas. */
function memoryLease(): JobLease & { held: Set<string> } {
  const held = new Set<string>();
  const lease = (async (key: string, _ttl: number, fn: () => Promise<unknown>) => {
    if (held.has(key)) return { acquired: false };
    held.add(key);
    try {
      return { acquired: true, result: await fn() };
    } finally {
      held.delete(key);
    }
  }) as JobLease & { held: Set<string> };
  lease.held = held;
  return lease;
}

function mod(jobs: ModuleJob<{ every: string | null }>[]): AnyModule {
  return defineModule<{ every: string | null }>({
    name: 'sync',
    version: '1.0.0',
    contract: '^1.2',
    skill: { useWhen: 'x', markdown: '# x' },
    configSchema: z.object({ every: z.string().nullable() }),
    configDefaults: { every: null },
    jobs,
  }) as AnyModule;
}

function fakeRuntime(modules: AnyModule[], rows: JobAppRow[] = []) {
  return {
    modules,
    async *jobApps() {
      for (const r of rows) yield r;
    },
    serverJobContext: (m: AnyModule, input: JobRunInput) => ({ module: m.name, ...input }) as unknown as ServerJobContext<unknown>,
    appJobContext: async (m: AnyModule, row: JobAppRow, input: JobRunInput) =>
      ({ module: m.name, app: row.app, config: row.config, ...input }) as unknown as AppJobContext<unknown>,
  };
}

const app = (id: string): HookApp => ({ id, slug: id, workspaceId: 'ws' });

function setup(opts: {
  modules: AnyModule[];
  rows?: JobAppRow[];
  concurrency?: number;
  timeoutMs?: number;
  state?: JobStateStore;
  lease?: JobLease;
  enabled?: boolean;
}) {
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  const state = opts.state ?? memoryJobStateStore(clock.now);
  const lease = opts.lease ?? memoryLease();
  const failures: ModuleJobFailureRecord[] = [];
  const log = logger();
  const make = () =>
    new ModuleJobScheduler({
      runtime: fakeRuntime(opts.modules, opts.rows),
      lease,
      state,
      log,
      now: clock.now,
      settings: { enabled: opts.enabled ?? true, concurrency: opts.concurrency ?? 4, timeoutMs: opts.timeoutMs ?? 5 * MIN },
      recordFailure: async (f) => {
        failures.push(f);
      },
    });
  return { scheduler: make(), make, clock, state, lease, failures, log };
}

async function tickAndSettle(s: ModuleJobScheduler) {
  await s.tick();
  await s.idle();
}

describe('timing', () => {
  it('backoff: 1 min doubling per consecutive failure, at most max(interval, 1 h)', () => {
    expect([1, 2, 3, 4].map((f) => jobBackoffMs(f, 5 * MIN))).toEqual([MIN, 2 * MIN, 4 * MIN, 8 * MIN]);
    expect(jobBackoffMs(20, 5 * MIN)).toBe(60 * MIN);
    expect(jobBackoffMs(20, 24 * 60 * MIN)).toBe(24 * 60 * MIN);
    expect(jobBackoffMs(1, 24 * 60 * MIN)).toBe(MIN);
  });

  it('due: now without state; interval after a success; backoff after a failure', () => {
    expect(jobDueAt(null, 5 * MIN)).toBe(0);
    expect(jobDueAt({ lastRunAt: 100, lastSuccessAt: 90, failures: 0 }, 5 * MIN)).toBe(100 + 5 * MIN);
    expect(jobDueAt({ lastRunAt: 100, lastSuccessAt: 90, failures: 2 }, 24 * 60 * MIN)).toBe(100 + 2 * MIN);
  });

  it('settings: production defaults, invalid values fall back with a warning, 0/false turns the jobs off', () => {
    expect(moduleJobsSettingsFromEnv({})).toEqual({ settings: { enabled: true, concurrency: 4, timeoutMs: 300_000 }, warnings: [] });
    expect(moduleJobsSettingsFromEnv({ MODULE_JOBS_ENABLED: '0', MODULE_JOBS_CONCURRENCY: '2', MODULE_JOBS_TIMEOUT_MS: '1000' }).settings).toEqual({
      enabled: false,
      concurrency: 2,
      timeoutMs: 1000,
    });
    expect(moduleJobsSettingsFromEnv({ MODULE_JOBS_ENABLED: 'false' }).settings.enabled).toBe(false);
    const bad = moduleJobsSettingsFromEnv({ MODULE_JOBS_ENABLED: 'maybe', MODULE_JOBS_CONCURRENCY: '-1', MODULE_JOBS_TIMEOUT_MS: 'soon' });
    expect(bad.settings).toEqual({ enabled: true, concurrency: 4, timeoutMs: 300_000 });
    expect(bad.warnings).toHaveLength(3);
  });
});

describe('a server job', () => {
  it('runs when due, not again before its interval, again after it — with lastSuccessAt of the previous run', async () => {
    const runs: (Date | null)[] = [];
    const t = setup({ modules: [mod([{ name: 'tick', every: '5m', run: (ctx) => void runs.push(ctx.lastSuccessAt) }])] });
    await tickAndSettle(t.scheduler);
    expect(runs).toEqual([null]);
    t.clock.advance(4 * MIN);
    await tickAndSettle(t.scheduler);
    expect(runs).toHaveLength(1);
    t.clock.advance(MIN);
    await tickAndSettle(t.scheduler);
    expect(runs).toEqual([null, new Date(1_000_000)]);
  });

  it('runs once across replicas that share the lease and the state', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    const t = setup({
      modules: [
        mod([
          {
            name: 'tick',
            every: '5m',
            run: async () => {
              runs++;
              await gate;
            },
          },
        ]),
      ],
    });
    const other = t.make();
    await t.scheduler.tick();
    await other.tick();
    release();
    await t.scheduler.idle();
    await other.idle();
    expect(runs).toBe(1);
    // The other replica sees the state the first one wrote: not due again.
    await tickAndSettle(other);
    expect(runs).toBe(1);
  });

  it('a failure is logged and retried with backoff; a server job writes nothing to an app’s get_logs', async () => {
    let fail = true;
    let runs = 0;
    const t = setup({
      modules: [
        mod([
          {
            name: 'tick',
            every: '1h',
            run: () => {
              runs++;
              if (fail) throw new Error('upstream said no, token=abc123');
            },
          },
        ]),
      ],
    });
    await tickAndSettle(t.scheduler);
    expect(runs).toBe(1);
    expect(t.log.error).toHaveBeenCalledWith('module job failed', expect.objectContaining({ module: 'sync', job: 'tick', failures: 1, retry_in_ms: MIN }));
    expect(JSON.stringify(t.log.error.mock.calls)).not.toContain('abc123');
    expect(t.failures).toEqual([]);
    t.clock.advance(MIN - 1);
    await tickAndSettle(t.scheduler);
    expect(runs).toBe(1);
    t.clock.advance(1);
    await tickAndSettle(t.scheduler);
    expect(runs).toBe(2);
    expect((await t.state.read([jobStateKey('sync', 'tick')]))[0]).toMatchObject({ failures: 2 });
    t.clock.advance(2 * MIN);
    fail = false;
    await tickAndSettle(t.scheduler);
    expect(runs).toBe(3);
    expect((await t.state.read([jobStateKey('sync', 'tick')]))[0]).toMatchObject({ failures: 0, lastSuccessAt: 1_000_000 + 3 * MIN });
  });

  it('a failure reaches the error reporter with module, job and app', async () => {
    const reported: ErrorReportEvent[] = [];
    installErrorReporter({ id: 'sink', label: 'Sink', report: (e) => void reported.push(e) }, {}, noopLogger);
    try {
      const appMod = defineModule<{ every: string | null }>({
        name: 'sync',
        version: '1.0.0',
        contract: '^1.2',
        skill: { useWhen: 'x', markdown: '# x' },
        configSchema: z.object({ every: z.string().nullable() }),
        configDefaults: { every: null },
        jobs: [
          { name: 'tick', every: '1h', run: () => { throw new Error('server side broke'); } },
          { name: 'pull', scope: 'app', every: () => '1h', run: () => { throw new Error('upstream refused'); } },
        ],
      }) as AnyModule;
      const t = setup({ modules: [appMod], rows: [{ app: app('a1'), config: { every: '1h' }, pendingConfig: null }] });
      await tickAndSettle(t.scheduler);
      await vi.waitFor(() => expect(reported).toHaveLength(2));
      const byJob = Object.fromEntries(reported.map((e) => [e.context.job, e]));
      expect(byJob.tick).toMatchObject({ message: 'module job failed', error: { message: 'server side broke' }, context: { kind: 'module_job', module: 'sync', job: 'tick' } });
      expect(byJob.tick!.context.appId).toBeUndefined();
      expect(byJob.pull).toMatchObject({ error: { message: 'upstream refused' }, context: { kind: 'module_job', module: 'sync', job: 'pull', appId: 'a1', workspaceId: 'ws' } });
    } finally {
      resetErrorReporterForTests();
    }
  });

  it('a run past the timeout is aborted and counts as failed', async () => {
    vi.useFakeTimers();
    try {
      let aborted: unknown = null;
      const t = setup({
        timeoutMs: 1000,
        modules: [
          mod([
            {
              name: 'hang',
              every: '5m',
              run: (ctx) =>
                new Promise<void>((resolve) => {
                  ctx.signal.addEventListener('abort', () => {
                    aborted = ctx.signal.reason;
                    resolve();
                  });
                }),
            },
          ]),
        ],
      });
      await t.scheduler.tick();
      expect(t.scheduler.active).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      await t.scheduler.idle();
      expect(String(aborted)).toMatch(/MODULE_JOBS_TIMEOUT_MS/);
      expect(t.scheduler.active).toBe(0);
      expect(t.log.error).toHaveBeenCalledWith('module job failed', expect.objectContaining({ job: 'hang', failures: 1 }));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('an app job', () => {
  const rows: JobAppRow[] = [
    { app: app('a1'), config: { every: '5m' }, pendingConfig: null },
    { app: app('a2'), config: { every: '1h' }, pendingConfig: null },
    { app: app('a3'), config: { every: null }, pendingConfig: null },
    { app: app('a4'), config: { every: 'whenever' }, pendingConfig: null },
  ];

  it('runs per app on the interval its config gives; null or an invalid interval skips the app (warned once)', async () => {
    const ran: string[] = [];
    const t = setup({
      rows,
      modules: [mod([{ name: 'import', scope: 'app', every: (c) => c.every as '5m' | null, run: (ctx) => void ran.push(ctx.app.id) }])],
    });
    await tickAndSettle(t.scheduler);
    expect(ran.sort()).toEqual(['a1', 'a2']);
    await tickAndSettle(t.scheduler);
    expect(t.log.warn).toHaveBeenCalledTimes(1);
    expect(t.log.warn).toHaveBeenCalledWith(expect.stringContaining('no valid interval'), expect.objectContaining({ app_id: 'a4' }));
    t.clock.advance(5 * MIN);
    await tickAndSettle(t.scheduler);
    expect(ran.sort()).toEqual(['a1', 'a1', 'a2']);
  });

  it('a config interval below a minute runs every minute', async () => {
    let runs = 0;
    const t = setup({
      rows: [{ app: app('a1'), config: { every: '10s' }, pendingConfig: null }],
      modules: [mod([{ name: 'import', scope: 'app', every: (c) => c.every as '10s', run: () => void runs++ }])],
    });
    await tickAndSettle(t.scheduler);
    t.clock.advance(30_000);
    await tickAndSettle(t.scheduler);
    expect(runs).toBe(1);
    t.clock.advance(30_000);
    await tickAndSettle(t.scheduler);
    expect(runs).toBe(2);
  });

  it('a failure lands in that app’s get_logs with module and job; the other apps are unaffected', async () => {
    const t = setup({
      rows: rows.slice(0, 2),
      modules: [
        mod([
          {
            name: 'import',
            scope: 'app',
            every: '5m',
            run: (ctx) => {
              if (ctx.app.id === 'a2') throw new Error('feed returned 503');
            },
          },
        ]),
      ],
    });
    await tickAndSettle(t.scheduler);
    expect(t.failures).toEqual([{ appId: 'a2', module: 'sync', job: 'import', message: 'feed returned 503' }]);
    expect((await t.state.read([jobStateKey('sync', 'import', 'a1')]))[0]).toMatchObject({ failures: 0 });
    expect((await t.state.read([jobStateKey('sync', 'import', 'a2')]))[0]).toMatchObject({ failures: 1 });
  });

  it('never more runs in flight than MODULE_JOBS_CONCURRENCY; the rest wait for a later tick', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ app: app(`b${i}`), config: { every: '5m' }, pendingConfig: null }));
    let release!: () => void;
    let gate = new Promise<void>((r) => (release = r));
    let peak = 0;
    let inFlight = 0;
    const ran: string[] = [];
    const t = setup({
      rows: many,
      concurrency: 2,
      modules: [
        mod([
          {
            name: 'import',
            scope: 'app',
            every: '5m',
            run: async (ctx) => {
              inFlight++;
              peak = Math.max(peak, inFlight);
              ran.push(ctx.app.id);
              await gate;
              inFlight--;
            },
          },
        ]),
      ],
    });
    await t.scheduler.tick();
    await t.scheduler.tick();
    expect(t.scheduler.active).toBe(2);
    release();
    await t.scheduler.idle();
    gate = new Promise<void>((r) => (release = r));
    release();
    for (let i = 0; i < 3; i++) await tickAndSettle(t.scheduler);
    expect(peak).toBe(2);
    expect(ran.sort()).toEqual(['b0', 'b1', 'b2', 'b3', 'b4']);
  });
});

describe('robustness', () => {
  it('a tick never throws: a broken state store or a throwing every() is logged', async () => {
    const broken: JobStateStore = {
      read: async () => {
        throw new Error('redis is down');
      },
      write: async () => {},
    };
    const t = setup({
      state: broken,
      rows: [{ app: app('a1'), config: { every: '5m' }, pendingConfig: null }],
      modules: [
        mod([
          { name: 'tick', every: '5m', run: () => {} },
          {
            name: 'import',
            scope: 'app',
            every: () => {
              throw new Error('bad config');
            },
            run: () => {},
          },
        ]),
      ],
    });
    await expect(t.scheduler.tick()).resolves.toBeUndefined();
    expect(t.log.error).toHaveBeenCalledWith('module job scheduling failed', expect.objectContaining({ job: 'tick' }));
    expect(t.log.warn).toHaveBeenCalledWith(expect.stringContaining('every() failed'), expect.objectContaining({ app_id: 'a1' }));
  });

  it('MODULE_JOBS_ENABLED=0: nothing runs', async () => {
    const run = vi.fn();
    const t = setup({ enabled: false, modules: [mod([{ name: 'tick', every: '5m', run }])] });
    await tickAndSettle(t.scheduler);
    expect(run).not.toHaveBeenCalled();
  });

  it('startModuleJobs: no timer without jobs or when off; stop() aborts a run in flight', async () => {
    const plain = defineModule({ name: 'plain', version: '1.0.0', skill: { useWhen: 'x', markdown: '# x' }, configSchema: z.object({}), configDefaults: {} });
    const log = logger();
    const setInterval = vi.spyOn(globalThis, 'setInterval');
    try {
      await startModuleJobs({ runtime: fakeRuntime([plain as AnyModule]), lease: memoryLease(), log, env: {} })();
      await startModuleJobs({ runtime: fakeRuntime([mod([{ name: 'tick', every: '5m', run: () => {} }])]), lease: memoryLease(), log, env: { MODULE_JOBS_ENABLED: '0' } })();
      expect(setInterval).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('MODULE_JOBS_ENABLED=0'));
    } finally {
      setInterval.mockRestore();
    }
    let aborted = false;
    const s = new ModuleJobScheduler({
      runtime: fakeRuntime([
        mod([
          {
            name: 'hang',
            every: '5m',
            run: (ctx) =>
              new Promise<void>((resolve) =>
                ctx.signal.addEventListener('abort', () => {
                  aborted = true;
                  resolve();
                })
              ),
          },
        ]),
      ]),
      lease: memoryLease(),
      state: memoryJobStateStore(),
      log,
      settings: { enabled: true, concurrency: 1, timeoutMs: 5 * MIN },
      recordFailure: async () => {},
    });
    await s.tick();
    await s.stop();
    expect(aborted).toBe(true);
    await s.tick();
    expect(s.active).toBe(0);
  });
});
