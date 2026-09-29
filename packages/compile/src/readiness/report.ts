import { errorHint } from '@drobek/agent-dx';
import { READINESS_CHECKS } from './checks/index.js';
import type { CheckFinding, ReadinessCheck, ReadinessFinding, ReadinessModule, ReadinessReport } from './types.js';

export interface ReadinessLimits {
  /** READINESS_MAX_WARNINGS: warnings one report lists; the rest are counted in `warnings_omitted`. */
  maxWarnings: number;
}

export const DEFAULT_READINESS_LIMITS: ReadinessLimits = { maxWarnings: 50 };

export function readinessLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): ReadinessLimits {
  const n = Number(env.READINESS_MAX_WARNINGS);
  return { maxWarnings: Number.isInteger(n) && n > 0 ? n : DEFAULT_READINESS_LIMITS.maxWarnings };
}

/** A compile error as the version stores it (`text`) or the MCP result shapes it (`hint` of a module import). */
export interface BlockingMessage {
  code?: string;
  file?: string | null;
  line?: number | null;
  text?: string;
  hint?: string;
}

export interface ReadinessOptions {
  files: ReadonlyMap<string, string | Buffer>;
  /** The version's compile errors — the blocking class. */
  blocking?: readonly BlockingMessage[];
  /** The app's module configs; called only when a check needs them. */
  loadModules?: () => Promise<readonly ReadinessModule[]>;
  limits?: ReadinessLimits;
  checks?: readonly ReadinessCheck[];
  /** A check (or the module load) that threw: it is left out of the report, never fails the caller. */
  onCheckError?: (checkId: string, err: unknown) => void;
}

/** `{ code, file?, line?, message, hint }` — in that key order, optional keys only when set. */
function finding(f: CheckFinding, hint?: string): ReadinessFinding {
  return {
    code: f.code,
    ...(f.file ? { file: f.file } : {}),
    ...(typeof f.line === 'number' && f.line > 0 ? { line: f.line } : {}),
    message: f.message,
    hint: hint || errorHint(f.code),
  };
}

function byPlace(a: CheckFinding, b: CheckFinding): number {
  const fa = a.file ?? '';
  const fb = b.file ?? '';
  if (fa !== fb) return fa < fb ? -1 : 1;
  return (a.line ?? 0) - (b.line ?? 0);
}

/**
 * Run every readiness check over one version's files. Deterministic: the same
 * files and module configs give the same report, ordered by check, then file
 * and line. It reads the in-memory file map only — app code is never run.
 */
export async function readinessReport(opts: ReadinessOptions): Promise<ReadinessReport> {
  const checks = opts.checks ?? READINESS_CHECKS;
  const limits = opts.limits ?? DEFAULT_READINESS_LIMITS;
  const blocking = (opts.blocking ?? []).map((m) =>
    finding(
      { code: String(m.code ?? 'build_error'), file: m.file ?? undefined, line: m.line ?? undefined, message: String(m.text ?? '') },
      m.hint
    )
  );

  let modules: readonly ReadinessModule[] = [];
  let modulesOk = true;
  if (opts.loadModules && checks.some((c) => c.needsModules)) {
    try {
      modules = await opts.loadModules();
    } catch (err) {
      modulesOk = false;
      opts.onCheckError?.('modules', err);
    }
  }

  const all: ReadinessFinding[] = [];
  for (const check of checks) {
    if (check.needsModules && !modulesOk) continue;
    try {
      const found = await check.run({ files: opts.files, modules });
      all.push(...[...found].sort(byPlace).map((f) => finding(f)));
    } catch (err) {
      opts.onCheckError?.(check.id, err);
    }
  }

  const warnings = all.slice(0, limits.maxWarnings);
  return {
    ready: blocking.length === 0,
    blocking,
    warnings,
    ...(all.length > warnings.length ? { warnings_omitted: all.length - warnings.length } : {}),
  };
}
