/**
 * The typecheck runner: checks run in worker threads, never on the
 * event loop that serves write_files and publish, and are bounded by
 * TYPECHECK_* limits — time (the worker is terminated), memory (the worker's
 * heap limit), files (a bigger app is not checked) and TYPECHECK_WORKERS
 * parallel checks. A worker that times out, runs out of memory or crashes
 * gives an `unavailable` result; nothing is thrown. Queued checks of the same
 * group (an app) collapse to the newest one.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { isTypeScriptPath, type TypeFinding, type TypecheckSdk } from './check.js';
import type { WorkerJob, WorkerReply } from './worker.js';

export interface TypecheckLimits {
  /** TYPECHECK_WORKERS: parallel checks (worker threads); 0 turns the check off. */
  workers: number;
  /** TYPECHECK_TIMEOUT_MS: one check's time budget; the worker is terminated after it. */
  timeoutMs: number;
  /** TYPECHECK_MAX_MEMORY_MB: a worker's heap limit. */
  maxMemoryMb: number;
  /** TYPECHECK_MAX_FILES: an app with more .ts/.tsx files is not checked. */
  maxFiles: number;
}

export const DEFAULT_TYPECHECK_LIMITS: TypecheckLimits = { workers: 1, timeoutMs: 20_000, maxMemoryMb: 512, maxFiles: 150 };

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isInteger(n) && n > 0 ? n : fallback;
}

export function typecheckLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): TypecheckLimits {
  const workers = Number(env.TYPECHECK_WORKERS);
  return {
    workers:
      env.TYPECHECK_WORKERS !== undefined && env.TYPECHECK_WORKERS !== '' && Number.isInteger(workers) && workers >= 0
        ? workers
        : DEFAULT_TYPECHECK_LIMITS.workers,
    timeoutMs: positiveInt(env.TYPECHECK_TIMEOUT_MS, DEFAULT_TYPECHECK_LIMITS.timeoutMs),
    maxMemoryMb: positiveInt(env.TYPECHECK_MAX_MEMORY_MB, DEFAULT_TYPECHECK_LIMITS.maxMemoryMb),
    maxFiles: positiveInt(env.TYPECHECK_MAX_FILES, DEFAULT_TYPECHECK_LIMITS.maxFiles),
  };
}

/** Why a check gave no result. `superseded` = a newer check of the same group replaced it in the queue. */
export type TypecheckFailure = 'timeout' | 'memory' | 'too_many_files' | 'crashed' | 'queue_full' | 'superseded' | 'closed';

export type TypecheckResult =
  | { status: 'checked'; findings: TypeFinding[]; total: number; durationMs: number }
  | { status: 'unavailable'; reason: TypecheckFailure; durationMs: number };

interface TypecheckLog {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface TypecheckRunnerOptions {
  limits: TypecheckLimits;
  sdk: TypecheckSdk;
  log?: TypecheckLog;
  /** Type errors one result keeps (the rest are counted in `total`). */
  maxFindings?: number;
  /** Test seam: the worker script (default: worker.js next to this file). */
  workerPath?: string;
}

interface Job {
  id: number;
  group?: string;
  files: Record<string, string>;
  started: number;
  resolve: (r: TypecheckResult) => void;
}

interface Slot {
  worker: Worker | null;
  job: Job | null;
  timer?: NodeJS.Timeout;
  idle?: NodeJS.Timeout;
}

/** Waiting checks beyond this are refused (`queue_full`); groups collapse first. */
const QUEUE_MAX = 200;
/** An idle worker (and its parsed lib.dom/@types/react cache) is let go after this. */
const IDLE_MS = 5 * 60_000;

export class TypecheckRunner {
  readonly limits: TypecheckLimits;
  private readonly sdk: TypecheckSdk;
  private readonly log?: TypecheckLog;
  private readonly maxFindings: number;
  private readonly workerPath: string;
  private readonly slots: Slot[];
  private readonly queue: Job[] = [];
  private readonly byKey = new Map<string, Promise<TypecheckResult>>();
  private nextId = 1;
  private closed = false;

  constructor(opts: TypecheckRunnerOptions) {
    this.limits = opts.limits;
    this.sdk = opts.sdk;
    this.log = opts.log;
    this.maxFindings = opts.maxFindings ?? 100;
    this.workerPath = opts.workerPath ?? join(dirname(fileURLToPath(import.meta.url)), 'worker.js');
    this.slots = Array.from({ length: Math.max(1, opts.limits.workers) }, () => ({ worker: null, job: null }));
  }

  stats(): { active: number; queued: number } {
    return { active: this.slots.filter((s) => s.job).length, queued: this.queue.length };
  }

  /**
   * Check `files` (text sources; binary assets are ignored). Always resolves.
   * A second call with the `key` of a queued or running check gets that
   * check's result.
   */
  run(files: ReadonlyMap<string, string | Buffer>, opts: { group?: string; key?: string } = {}): Promise<TypecheckResult> {
    const key = opts.key;
    if (key !== undefined) {
      const running = this.byKey.get(key);
      if (running) return running;
      const p = this.enqueue(files, opts.group);
      this.byKey.set(key, p);
      void p.then(() => this.byKey.delete(key));
      return p;
    }
    return this.enqueue(files, opts.group);
  }

  private enqueue(files: ReadonlyMap<string, string | Buffer>, group: string | undefined): Promise<TypecheckResult> {
    const started = Date.now();
    const unavailable = (reason: TypecheckFailure) =>
      Promise.resolve<TypecheckResult>({ status: 'unavailable', reason, durationMs: Date.now() - started });
    if (this.closed) return unavailable('closed');
    const text: Record<string, string> = {};
    let tsFiles = 0;
    for (const [path, content] of files) {
      if (typeof content !== 'string') continue;
      text[path] = content;
      if (isTypeScriptPath(path)) tsFiles++;
    }
    if (tsFiles === 0) return Promise.resolve({ status: 'checked', findings: [], total: 0, durationMs: 0 });
    if (tsFiles > this.limits.maxFiles) return unavailable('too_many_files');

    return new Promise<TypecheckResult>((resolve) => {
      if (group !== undefined) {
        const i = this.queue.findIndex((j) => j.group === group);
        if (i >= 0) {
          const [old] = this.queue.splice(i, 1);
          old.resolve({ status: 'unavailable', reason: 'superseded', durationMs: Date.now() - old.started });
        }
      }
      if (this.queue.length >= QUEUE_MAX) {
        resolve({ status: 'unavailable', reason: 'queue_full', durationMs: 0 });
        return;
      }
      this.queue.push({ id: this.nextId++, group, files: text, started, resolve });
      this.dispatch();
    });
  }

  /** Stop every worker; queued and running checks resolve `closed`. */
  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) job.resolve({ status: 'unavailable', reason: 'closed', durationMs: Date.now() - job.started });
    await Promise.all(
      this.slots.map(async (slot) => {
        clearTimeout(slot.idle);
        if (slot.job) this.finish(slot, { status: 'unavailable', reason: 'closed', durationMs: Date.now() - slot.job.started }, false);
        const w = slot.worker;
        slot.worker = null;
        if (w) await w.terminate();
      })
    );
  }

  private dispatch(): void {
    for (const slot of this.slots) {
      if (this.queue.length === 0) return;
      if (slot.job) continue;
      this.start(slot, this.queue.shift()!);
    }
  }

  private start(slot: Slot, job: Job): void {
    clearTimeout(slot.idle);
    slot.job = job;
    const worker = slot.worker ?? this.spawn(slot);
    slot.timer = setTimeout(() => {
      this.log?.warn('typecheck timed out', { timeout_ms: this.limits.timeoutMs });
      this.kill(slot);
      this.finish(slot, { status: 'unavailable', reason: 'timeout', durationMs: Date.now() - job.started });
    }, this.limits.timeoutMs);
    slot.timer.unref();
    worker.postMessage({ id: job.id, files: job.files, maxFindings: this.maxFindings } satisfies WorkerJob);
  }

  private spawn(slot: Slot): Worker {
    const worker = new Worker(this.workerPath, {
      workerData: this.sdk,
      // The checker needs no configuration: the server's secrets stay out of the worker.
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: this.limits.maxMemoryMb },
    });
    worker.unref();
    slot.worker = worker;
    worker.on('message', (reply: WorkerReply) => {
      const job = slot.job;
      if (slot.worker !== worker || !job || reply.id !== job.id) return;
      if (reply.ok) {
        this.finish(slot, { status: 'checked', findings: reply.findings, total: reply.total, durationMs: Date.now() - job.started });
      } else {
        this.log?.warn('typecheck failed', { error: reply.error });
        this.finish(slot, { status: 'unavailable', reason: 'crashed', durationMs: Date.now() - job.started });
      }
    });
    worker.on('error', (err: Error & { code?: string }) => {
      if (slot.worker !== worker) return;
      const memory = err.code === 'ERR_WORKER_OUT_OF_MEMORY';
      this.log?.warn(memory ? 'typecheck ran out of memory' : 'typecheck worker crashed', {
        ...(memory ? { max_memory_mb: this.limits.maxMemoryMb } : { worker_error: err.code ?? err.name }),
      });
      slot.worker = null;
      const job = slot.job;
      if (job) this.finish(slot, { status: 'unavailable', reason: memory ? 'memory' : 'crashed', durationMs: Date.now() - job.started });
    });
    worker.on('exit', () => {
      if (slot.worker !== worker) return;
      slot.worker = null;
      const job = slot.job;
      if (job) this.finish(slot, { status: 'unavailable', reason: 'crashed', durationMs: Date.now() - job.started });
    });
    return worker;
  }

  private kill(slot: Slot): void {
    const w = slot.worker;
    slot.worker = null;
    if (w) void w.terminate();
  }

  private finish(slot: Slot, result: TypecheckResult, next = true): void {
    const job = slot.job;
    clearTimeout(slot.timer);
    slot.job = null;
    job?.resolve(result);
    if (slot.worker) {
      slot.idle = setTimeout(() => {
        if (!slot.job) this.kill(slot);
      }, IDLE_MS);
      slot.idle.unref();
    }
    if (next && !this.closed) this.dispatch();
  }
}

const GLOBAL_KEY = Symbol.for('drobek.typecheck.runner');
type Holder = { [GLOBAL_KEY]?: TypecheckRunner | null };

/**
 * Make `runner` the process-wide runner (the server entry installs it at boot
 * with the SDK declarations). Shared through globalThis, so the dashboard's
 * bundled copy of the workspace packages sees the same runner.
 */
export function installTypecheckRunner(runner: TypecheckRunner | null): void {
  (globalThis as Holder)[GLOBAL_KEY] = runner;
}

/** The process-wide runner; null when none is installed or TYPECHECK_WORKERS=0. */
export function typecheckRunner(): TypecheckRunner | null {
  const r = (globalThis as Holder)[GLOBAL_KEY] ?? null;
  return r && r.limits.workers > 0 ? r : null;
}
