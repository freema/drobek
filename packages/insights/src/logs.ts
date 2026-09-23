/**
 * get_logs (M1-07) — the pure half: status classes, the capped compile-error
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
export const COMPILE_ERROR_TEXT_MAX = 500;
/** A runtime entry carries the head of the latest stack (lines). */
export const STACK_HEAD_LINES = 6;

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

export interface RequestsEntry {
  /** UTC day `YYYY-MM-DD`. */
  day: string;
  /** Every request to the app's hosts (files + module calls). */
  requests: number;
  count_5xx: number;
  count_404: number;
  /** Module calls (`/__drobek/v1/<module>/…`) by status class. */
  modules: Record<string, ModuleCounts>;
}

function emptyCounts(): ModuleCounts {
  return { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
}

/** Per-day totals + per-module status classes, newest day first, ≤ 100 days. */
export function requestEntries(daily: DailyRow[], modules: ModuleStatRow[]): RequestsEntry[] {
  const byDay = new Map<string, RequestsEntry>();
  const entry = (day: string) => {
    let e = byDay.get(day);
    if (!e) {
      e = { day, requests: 0, count_5xx: 0, count_404: 0, modules: {} };
      byDay.set(day, e);
    }
    return e;
  };
  for (const d of daily) {
    const e = entry(d.day);
    e.requests += d.requestCount;
    e.count_5xx += d.count5xx;
    e.count_404 += Object.values(d.path404Counts ?? {}).reduce((a, n) => a + (Number(n) || 0), 0);
  }
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
