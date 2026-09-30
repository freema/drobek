/**
 * get_logs — the pure half: status classes, the capped compile-error
 * shape that is stored, and the agent-facing entry shapes of the three kinds
 * (`runtime`, `compile`, `requests`). No DB / no Redis here → unit-tested.
 */
import type { DedupedError } from './shape.js';

export type LogKind = 'runtime' | 'compile' | 'requests';
export const LOG_KINDS: readonly LogKind[] = ['runtime', 'compile', 'requests'];

/** get_logs answers at most this many entries. */
export const LOG_ENTRIES_MAX = 100;
/** get_logs('compile') returns the last N compiles. */
export const COMPILE_LOG_LIMIT = 50;
/** Stored per compile: at most this many errors, each text capped. */
export const COMPILE_ERRORS_KEEP = 20;
const COMPILE_ERROR_TEXT_MAX = 500;
/** A runtime entry carries the head of the latest stack (lines). */
const STACK_HEAD_LINES = 6;

export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx';
export const STATUS_CLASSES: readonly StatusClass[] = ['2xx', '3xx', '4xx', '5xx'];

/** HTTP status → its class (1xx and anything odd count as 2xx/5xx at the edges). */
export function statusClass(status: number): StatusClass {
  if (status >= 500 || !Number.isFinite(status)) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  return '2xx';
}

export interface StoredCompileError {
  code: string;
  file: string | null;
  line: number | null;
  column: number | null;
  text: string;
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The compile errors as stored: ≤ 20, the known fields only, texts capped. */
export function capCompileErrors(errors: unknown): StoredCompileError[] {
  if (!Array.isArray(errors)) return [];
  return errors.slice(0, COMPILE_ERRORS_KEEP).map((raw) => {
    const e = (raw ?? {}) as Record<string, unknown>;
    return {
      code: typeof e.code === 'string' ? e.code : 'build_error',
      file: typeof e.file === 'string' ? e.file : null,
      line: typeof e.line === 'number' ? e.line : null,
      column: typeof e.column === 'number' ? e.column : null,
      text: cap(typeof e.text === 'string' ? e.text : '', COMPILE_ERROR_TEXT_MAX),
    };
  });
}

// ── runtime ──────────────────────────────────────────────────────────────────

export interface RuntimeEntry {
  type: string;
  message: string;
  count: number;
  first_seen: string;
  last_seen: string;
  /** The page the latest occurrence fired on (its host tells preview from production). */
  url: string;
  file_hint: string | null;
  /** The first lines of the latest stack (redacted), when the browser sent one. */
  stack: string | null;
  /** Type `module_job` only: the platform module and its job whose run failed (url is empty). */
  module?: string;
  job?: string;
}

export function stackHead(stack: string | null, lines = STACK_HEAD_LINES): string | null {
  if (!stack) return null;
  return stack.split('\n').slice(0, lines).join('\n');
}

/** Deduped errors (+ the latest stack per key) → runtime entries, newest-seen first. */
export function runtimeEntries(errors: DedupedError[], stacks: Map<string, string | null>): RuntimeEntry[] {
  return [...errors]
    .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : b.count - a.count))
    .slice(0, LOG_ENTRIES_MAX)
    .map((e) => ({
      type: e.type,
      message: e.message,
      count: e.count,
      first_seen: e.firstSeen,
      last_seen: e.lastSeen,
      url: e.lastUrl,
      file_hint: e.fileHint,
      stack: stackHead(stacks.get(e.dedupKey) ?? null),
      ...(e.module ? { module: e.module } : {}),
      ...(e.job ? { job: e.job } : {}),
    }));
}

// ── compile ──────────────────────────────────────────────────────────────────

export interface CompileRow {
  versionNumber: number | null;
  ok: boolean;
  errors: unknown;
  warningCount: number;
  durationMs: number;
  trigger: string;
  createdAt: Date;
}

export interface CompileEntry {
  at: string;
  /** The version the compile produced; null = the write was refused, nothing stored. */
  version: number | null;
  ok: boolean;
  errors: StoredCompileError[];
  warning_count: number;
  duration_ms: number;
  trigger: string;
}

export function compileEntries(rows: CompileRow[]): CompileEntry[] {
  return rows.slice(0, COMPILE_LOG_LIMIT).map((r) => ({
    at: r.createdAt.toISOString(),
    version: r.versionNumber,
    ok: r.ok,
    errors: capCompileErrors(r.errors),
    warning_count: r.warningCount,
    duration_ms: r.durationMs,
    trigger: r.trigger,
  }));
}

// ── requests ─────────────────────────────────────────────────────────────────

export interface DailyRow {
  day: string;
  requestCount: number;
  count5xx: number;
  path404Counts: Record<string, number> | null;
}

export interface ModuleStatRow {
  day: string;
  module: string;
  statusClass: string;
  count: number;
}

export type ModuleCounts = Record<StatusClass, number>;

/** get_logs('requests') lists at most this many failing paths per status class and day. */
export const FAILING_PATHS_TOP = 10;

export interface FailingPath {
  /** The request path only (no query, no fragment, ≤ 256 chars); `__other__` = paths past the per-day cap. */
  path: string;
  count: number;
}

/** One day's failing paths by status class, as counted ({ path: count }). */
export interface DayFailingPaths {
  '4xx'?: Record<string, number | string> | null;
  '5xx'?: Record<string, number | string> | null;
}

export interface RequestsEntry {
  /** UTC day `YYYY-MM-DD`. */
  day: string;
  /** Every request to the app's hosts (files + module calls). */
  requests: number;
  count_5xx: number;
  count_404: number;
  /** Module calls (`/__drobek/v1/<module>/…`) by status class. */
  modules: Record<string, ModuleCounts>;
  /** The most frequent failing paths of the day per status class, ≤ 10 each, most frequent first. */
  failing_paths: { '4xx': FailingPath[]; '5xx': FailingPath[] };
}

function emptyCounts(): ModuleCounts {
  return { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
}

function addCounts(into: Map<string, number>, counts: Record<string, number | string> | null | undefined): void {
  for (const [path, raw] of Object.entries(counts ?? {})) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) into.set(path, (into.get(path) ?? 0) + n);
  }
}

function topPaths(counts: Map<string, number>): FailingPath[] {
  return [...counts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, FAILING_PATHS_TOP)
    .map(([path, count]) => ({ path, count }));
}

/**
 * Per-day totals + per-module status classes, newest day first, ≤ 100 days.
 * `failing` adds the day's platform-4xx / 5xx paths; the 4xx list
 * also takes the day's file 404s (`path404Counts`).
 */
export function requestEntries(
  daily: DailyRow[],
  modules: ModuleStatRow[],
  failing: Map<string, DayFailingPaths> = new Map()
): RequestsEntry[] {
  const byDay = new Map<string, RequestsEntry>();
  const entry = (day: string) => {
    let e = byDay.get(day);
    if (!e) {
      e = { day, requests: 0, count_5xx: 0, count_404: 0, modules: {}, failing_paths: { '4xx': [], '5xx': [] } };
      byDay.set(day, e);
    }
    return e;
  };
  const paths4xx = new Map<string, Map<string, number>>();
  const paths5xx = new Map<string, Map<string, number>>();
  const bucket = (m: Map<string, Map<string, number>>, day: string) => {
    let b = m.get(day);
    if (!b) m.set(day, (b = new Map()));
    return b;
  };
  for (const d of daily) {
    const e = entry(d.day);
    e.requests += d.requestCount;
    e.count_5xx += d.count5xx;
    e.count_404 += Object.values(d.path404Counts ?? {}).reduce((a, n) => a + (Number(n) || 0), 0);
    addCounts(bucket(paths4xx, d.day), d.path404Counts);
  }
  for (const [day, f] of failing) {
    if (!f['4xx'] && !f['5xx']) continue;
    addCounts(bucket(paths4xx, day), f['4xx']);
    addCounts(bucket(paths5xx, day), f['5xx']);
  }
  for (const [day, counts] of paths4xx) if (counts.size > 0) entry(day).failing_paths['4xx'] = topPaths(counts);
  for (const [day, counts] of paths5xx) if (counts.size > 0) entry(day).failing_paths['5xx'] = topPaths(counts);
  for (const m of modules) {
    if (!(STATUS_CLASSES as readonly string[]).includes(m.statusClass)) continue;
    const e = entry(m.day);
    const counts = (e.modules[m.module] ??= emptyCounts());
    counts[m.statusClass as StatusClass] += m.count;
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0)).slice(0, LOG_ENTRIES_MAX);
}

/** Every UTC day from `from` through `to` (inclusive, `YYYY-MM-DD`), capped. */
export function daysBetween(from: string, to: string, max = 400): string[] {
  const out: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return out;
  for (let t = start; t <= end && out.length < max; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
