/**
 * One run of one source, the scheduled pass over an app's sources, and the
 * owner's view (the `sync` authority).
 *
 * A run: take the source's lease (`running_until` — one run of a source at a
 * time, across replicas), count it against the app's hourly budget
 * (SYNC_RUNS_PER_HOUR_PER_APP), fetch through `ctx.upstreams` (the proxy
 * module: assignment, secret, SSRF guard, SYNC_MAX_RESPONSE_BYTES), take the
 * array at `items` (SYNC_MAX_RECORDS_PER_RUN), write it with
 * `ctx.records.import` (the data module: schema + quotas, ONE transaction —
 * a failed run leaves the collection as it was), then store the outcome:
 * the source's state, a row of its run history (the newest 50 kept) and an
 * audit row `sync.run`. A failure counts towards SYNC_PAUSE_AFTER_FAILURES
 * (then the source pauses until the owner resumes it, a run succeeds or its
 * config changes) and backs the next scheduled run off.
 */
import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { dbErrorForLog, type DB } from '@drobek/db';
import { ModuleError, isModuleError, type AppJobContext, type ModuleAppView, type OwnerView, type SyncRun, type SyncSourceState } from '@drobek/modules';
import { activeSourceNames, effectiveEvery, effectiveIntervalMs, sourceHash, syncLimits, type SyncConfig, type SyncLimits, type SyncSource } from './config.js';
import { SyncRunError, pickRecords } from './items.js';
import { syncRuns, syncSources, type SyncRunRow, type SyncSourceRow } from './schema.js';

/** How long a run holds its source's lease (a crashed run frees it then). */
const LEASE_MS = 2 * 60_000;
/** Run history kept per source. */
export const RUNS_KEPT = 50;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MAX_ERROR_CHARS = 500;

type Ctx = AppJobContext<SyncConfig>;

/** The delay before the next scheduled run after `failures` failed runs in a row: the interval, doubling, at most max(interval, 1 day). */
export function backoffMs(failures: number, intervalMs: number): number {
  if (failures <= 0) return intervalMs;
  return Math.min(intervalMs * 2 ** Math.min(failures, 10), Math.max(intervalMs, DAY_MS));
}

async function loadStates(db: DB, appId: string): Promise<Map<string, SyncSourceRow>> {
  const rows = await db.select().from(syncSources).where(eq(syncSources.appId, appId));
  return new Map(rows.map((r) => [r.source, r]));
}

/** The row's counters belong to another config of the source (or there is no row): it starts over. */
function isFresh(row: SyncSourceRow | null | undefined, source: SyncSource): boolean {
  return !row || row.configHash !== sourceHash(source);
}

/** When the next scheduled run of a source is due (epoch ms). */
function dueAt(row: SyncSourceRow | null | undefined, source: SyncSource, limits: SyncLimits, now: number): number {
  if (isFresh(row, source) || !row?.lastRunAt) return now;
  return row.lastRunAt.getTime() + backoffMs(row.failures, effectiveIntervalMs(source, limits.minIntervalMin));
}

function errorText(err: unknown, ctx: Pick<Ctx, 'log' | 'app'>, source: string): string {
  let text: string;
  if (err instanceof SyncRunError || isModuleError(err)) text = err.message;
  else {
    ctx.log.error('sync run failed', { app_id: ctx.app.id, source, error: dbErrorForLog(err, { stack: true }) });
    text = 'drobek could not finish the run (an internal error) — it is retried on schedule';
  }
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
}

function toRun(row: SyncRunRow): SyncRun {
  return {
    source: row.source,
    trigger: row.trigger,
    started_at: row.startedAt.toISOString(),
    duration_ms: row.durationMs,
    status: row.status,
    records: row.records,
    ...(row.inserted !== null ? { inserted: row.inserted } : {}),
    ...(row.updated !== null ? { updated: row.updated } : {}),
    ...(row.deleted !== null ? { deleted: row.deleted } : {}),
    error: row.error,
  };
}

interface RunSourceInput {
  ctx: Ctx;
  name: string;
  source: SyncSource;
  trigger: 'schedule' | 'manual';
  limits: SyncLimits;
}

/**
 * One run (see the file header). null: a scheduled run that did not start
 * (another run of the source holds the lease, or the app's hourly budget is
 * spent); a manual one throws ModuleError `conflict` / `rate_limited` then.
 */
export async function runSource(input: RunSourceInput): Promise<SyncRun | null> {
  const { ctx, name, source, trigger, limits } = input;
  const db = ctx.db;
  const appId = ctx.app.id;
  const hash = sourceHash(source);
  const started = new Date();
  const leaseUntil = new Date(started.getTime() + LEASE_MS);
  const [claimed] = await db
    .insert(syncSources)
    .values({ appId, source: name, configHash: hash, runningUntil: leaseUntil })
    .onConflictDoUpdate({
      target: [syncSources.appId, syncSources.source],
      set: { runningUntil: leaseUntil },
      where: or(isNull(syncSources.runningUntil), lt(syncSources.runningUntil, started)),
    })
    .returning();
  if (!claimed) {
    if (trigger === 'manual') {
      throw new ModuleError('conflict', `A run of the source "${name}" is in progress — wait for it to finish, then check get_logs(kind: "sync").`);
    }
    return null;
  }
  const scope = and(eq(syncSources.appId, appId), eq(syncSources.source, name));
  const release = () => db.update(syncSources).set({ runningUntil: null }).where(scope);

  const budget = await ctx.rateLimit('runs', 'app', limits.runsPerHour, HOUR_MS).catch(async (err: unknown) => {
    await release();
    throw err;
  });
  if (!budget.ok) {
    await release();
    if (trigger === 'manual') {
      throw new ModuleError('rate_limited', `This app used its ${limits.runsPerHour} sync runs of this hour (SYNC_RUNS_PER_HOUR_PER_APP).`, {
        details: { limit: 'SYNC_RUNS_PER_HOUR_PER_APP', value: limits.runsPerHour, retry_after_seconds: budget.retryAfterSec },
        headers: { 'Retry-After': String(budget.retryAfterSec) },
      });
    }
    ctx.log.warn('sync run skipped: the app used its hourly runs', { app_id: appId, source: name, limit: limits.runsPerHour });
    return null;
  }

  let outcome: { records: number; inserted: number; updated: number; deleted: number } | null = null;
  let error: string | null = null;
  try {
    const res = await ctx.upstreams.fetch(source.upstream, {
      method: source.method,
      path: source.path,
      ...(source.body !== undefined ? { body: source.body } : {}),
      headers: { accept: 'application/json' },
      maxBytes: limits.maxResponseBytes,
    });
    if (res.status < 200 || res.status > 299) throw new SyncRunError(`the upstream answered HTTP ${res.status}`);
    let json: unknown;
    try {
      json = JSON.parse(res.body.toString('utf8'));
    } catch {
      throw new SyncRunError('the upstream answer is not JSON');
    }
    const records = pickRecords(json, source.items, limits.maxRecordsPerRun);
    const written = await ctx.records.import(source.collection, records, { mode: source.mode, ...(source.key !== undefined ? { key: source.key } : {}) });
    outcome = { records: records.length, ...written };
  } catch (err) {
    error = errorText(err, ctx, name);
  }

  const durationMs = Math.max(0, Date.now() - started.getTime());
  const sameConfig = claimed.configHash === hash;
  if (outcome) {
    await db
      .update(syncSources)
      .set({
        configHash: hash,
        lastRunAt: started,
        lastStatus: 'ok',
        lastRecords: outcome.records,
        lastError: null,
        lastSuccessAt: started,
        failures: 0,
        pausedAt: null,
        runningUntil: null,
      })
      .where(scope);
  } else {
    const failures = (sameConfig ? claimed.failures : 0) + 1;
    const pausedAt = sameConfig && claimed.pausedAt ? claimed.pausedAt : failures >= limits.pauseAfterFailures ? new Date() : null;
    await db
      .update(syncSources)
      .set({ configHash: hash, lastRunAt: started, lastStatus: 'failed', lastRecords: null, lastError: error, failures, pausedAt, runningUntil: null })
      .where(scope);
    if (pausedAt && !(sameConfig && claimed.pausedAt)) {
      ctx.log.warn('sync source paused after failed runs', { app_id: appId, source: name, failures });
    }
  }

  const [row] = await db
    .insert(syncRuns)
    .values({
      id: createId(),
      appId,
      source: name,
      trigger,
      startedAt: started,
      durationMs,
      status: outcome ? 'ok' : 'failed',
      records: outcome?.records ?? null,
      inserted: outcome?.inserted ?? null,
      updated: outcome?.updated ?? null,
      deleted: outcome?.deleted ?? null,
      error,
    })
    .returning();
  await db.execute(
    sql`DELETE FROM ${syncRuns} WHERE ${syncRuns.id} IN (SELECT ${syncRuns.id} FROM ${syncRuns} WHERE ${syncRuns.appId} = ${appId} AND ${syncRuns.source} = ${name} ORDER BY ${syncRuns.startedAt} DESC, ${syncRuns.id} DESC OFFSET ${RUNS_KEPT})`
  );
  await ctx
    .audit('run', {
      source: name,
      trigger,
      status: outcome ? 'ok' : 'failed',
      records: outcome?.records ?? null,
      ...(error ? { error: error.slice(0, 300) } : {}),
    })
    .catch((err: unknown) => ctx.log.error('sync run audit not written', { app_id: appId, source: name, error: dbErrorForLog(err) }));
  return toRun(row);
}

/**
 * The scheduled pass (the module's app job, every minute while the app has a
 * source): each active source that is not paused and is due runs, one after
 * the other; the state of sources no longer in the config is dropped.
 */
export async function runDueSources(ctx: Ctx, now: () => number = Date.now): Promise<void> {
  const limits = syncLimits(await ctx.limits());
  const states = await loadStates(ctx.db, ctx.app.id);
  for (const name of activeSourceNames(ctx.config, limits.maxSources)) {
    if (ctx.signal.aborted) return;
    const source = ctx.config.sources[name];
    if (source.paused) continue;
    const row = states.get(name);
    const fresh = isFresh(row, source);
    if (!fresh && row?.pausedAt) continue;
    if (row?.runningUntil && row.runningUntil.getTime() > now()) continue;
    if (now() < dueAt(row, source, limits, now())) continue;
    await runSource({ ctx, name, source, trigger: 'schedule', limits });
  }
  const gone = [...states.keys()].filter((n) => !Object.prototype.hasOwnProperty.call(ctx.config.sources, n));
  if (gone.length > 0) await ctx.db.delete(syncSources).where(and(eq(syncSources.appId, ctx.app.id), inArray(syncSources.source, gone)));
}

function requireSource(config: SyncConfig, name: string): SyncSource {
  if (!Object.prototype.hasOwnProperty.call(config.sources, name)) {
    const available = Object.keys(config.sources).sort();
    throw new ModuleError(
      'not_found',
      available.length > 0
        ? `This app has no sync source "${name}" (it has ${available.map((n) => `"${n}"`).join(', ')}).`
        : `This app has no sync source "${name}" — add one with configure_module('sync', { sources: { "${name}": { … } } }).`,
      { details: { available } }
    );
  }
  return config.sources[name];
}

/** Run one source now, for a person (the dashboard's Run now, MCP sync_now): rate limited, a paused source too. */
export async function runNow(ctx: Ctx, name: string): Promise<SyncRun> {
  const source = requireSource(ctx.config, name);
  const limits = syncLimits(await ctx.limits());
  if (!activeSourceNames(ctx.config, limits.maxSources).includes(name)) {
    throw new ModuleError('limit_exceeded', `The source "${name}" is past this app's ${limits.maxSources} sources (SYNC_MAX_SOURCES_PER_APP) and does not run — remove a source first.`, {
      details: { limit: 'SYNC_MAX_SOURCES_PER_APP', value: limits.maxSources },
    });
  }
  const rl = await ctx.rateLimit('now', name, limits.nowPerMinute, 60_000);
  if (!rl.ok) {
    throw new ModuleError('rate_limited', `The source "${name}" ran by hand ${limits.nowPerMinute} times this minute (SYNC_NOW_PER_MINUTE) — wait ${rl.retryAfterSec} s.`, {
      details: { limit: 'SYNC_NOW_PER_MINUTE', value: limits.nowPerMinute, retry_after_seconds: rl.retryAfterSec },
      headers: { 'Retry-After': String(rl.retryAfterSec) },
    });
  }
  const run = await runSource({ ctx, name, source, trigger: 'manual', limits });
  return run!;
}

/** The sources of the app as the owner sees them (config + state), in name order. */
export async function sourceStates(view: Pick<ModuleAppView<SyncConfig>, 'app' | 'config' | 'db'>, limits: SyncLimits, now = Date.now()): Promise<SyncSourceState[]> {
  const states = await loadStates(view.db, view.app.id);
  const active = new Set(activeSourceNames(view.config, limits.maxSources));
  return Object.keys(view.config.sources)
    .sort()
    .map((name) => {
      const source = view.config.sources[name];
      const row = states.get(name);
      const fresh = isFresh(row, source);
      const paused: SyncSourceState['paused'] = !active.has(name) ? 'limit' : source.paused ? 'owner' : !fresh && row?.pausedAt ? 'failures' : null;
      return {
        name,
        upstream: source.upstream,
        path: source.path,
        collection: source.collection,
        mode: source.mode,
        every: effectiveEvery(source, limits.minIntervalMin),
        paused,
        failures: fresh ? 0 : (row?.failures ?? 0),
        last_run_at: row?.lastRunAt?.toISOString() ?? null,
        last_status: row?.lastStatus ?? null,
        last_records: row?.lastRecords ?? null,
        last_error: row?.lastError ?? null,
        last_success_at: row?.lastSuccessAt?.toISOString() ?? null,
        next_run_at: paused ? null : new Date(Math.max(dueAt(row, source, limits, now), now)).toISOString(),
      };
    });
}

/** The latest runs of the app (newest first). */
export async function recentRuns(db: DB, appId: string, q: { source?: string; since?: Date; limit?: number }): Promise<SyncRun[]> {
  const limit = Math.min(Math.max(Math.floor(q.limit ?? 50), 1), 100);
  const rows = await db
    .select()
    .from(syncRuns)
    .where(
      and(
        eq(syncRuns.appId, appId),
        q.source !== undefined ? eq(syncRuns.source, q.source) : undefined,
        q.since !== undefined ? gte(syncRuns.startedAt, q.since) : undefined
      )
    )
    .orderBy(desc(syncRuns.startedAt), desc(syncRuns.id))
    .limit(limit);
  return rows.map(toRun);
}

/** Clear a pause after failures (the next scheduled run is due at once); false when the source was not paused so. */
export async function resumeSource(view: OwnerView<SyncConfig>, name: string): Promise<boolean> {
  requireSource(view.config, name);
  const rows = await view.db
    .update(syncSources)
    // A cleared config hash makes the next scheduled pass treat the source as new: it runs at once.
    .set({ pausedAt: null, failures: 0, configHash: null })
    .where(and(eq(syncSources.appId, view.app.id), eq(syncSources.source, name), sql`${syncSources.pausedAt} IS NOT NULL`))
    .returning({ source: syncSources.source });
  return rows.length > 0;
}

/** Forget an app's sources and runs (the app was deleted). */
export async function forgetApp(db: DB, appId: string): Promise<void> {
  await db.delete(syncRuns).where(eq(syncRuns.appId, appId));
  await db.delete(syncSources).where(eq(syncSources.appId, appId));
}
