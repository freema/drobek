/**
 * The background TypeScript check of a stored version (NSO-388). write_files
 * schedules it after the version is stored and answers without waiting; the
 * result lands in `app_versions.typecheck` and joins the version's readiness
 * report as `type_error` warnings (get_app, publish, the dashboard). A version
 * nobody scheduled (older than the check, or a server restart dropped it) is
 * scheduled when its report is read. Only versions that compiled and have a
 * .ts/.tsx file are checked; the check only analyses the sources.
 */
import { eq } from 'drizzle-orm';
import { createConsoleLogger, type Logger } from '@drobek/core';
import type { CheckFinding } from '@drobek/compile';
import { isTypeScriptPath, typecheckRunner, type TypeFinding, type TypecheckFailure } from '@drobek/compile/typecheck';
import { appVersions, dbErrorForLog, getDb } from '@drobek/db';

/** What `app_versions.typecheck` holds. */
type StoredTypecheck =
  | { status: 'checked'; findings: TypeFinding[]; total: number; duration_ms: number }
  | { status: 'unavailable'; reason: TypecheckFailure; duration_ms: number };

/** Results not worth storing: the version is checked again when its report is read. */
const RETRY: ReadonlySet<TypecheckFailure> = new Set(['superseded', 'queue_full', 'closed']);

const defaultLog = createConsoleLogger('typecheck');

function hasTypeScript(files: ReadonlyMap<string, unknown>): boolean {
  for (const path of files.keys()) if (isTypeScriptPath(path)) return true;
  return false;
}

/**
 * Queue the check of version `version` (its source files) and store the
 * result. Returns 'pending' when a check was queued (or already runs), else
 * undefined: the check is off, or there is nothing to check. Never throws.
 */
export function scheduleVersionTypecheck(
  version: { id: string; appId: string },
  files: ReadonlyMap<string, string | Buffer>,
  log: Pick<Logger, 'warn'> = defaultLog
): 'pending' | undefined {
  const runner = typecheckRunner();
  if (!runner || !hasTypeScript(files)) return undefined;
  void runner
    .run(files, { group: version.appId, key: version.id })
    .then(async (r) => {
      if (r.status === 'unavailable' && RETRY.has(r.reason)) return;
      const stored: StoredTypecheck =
        r.status === 'checked'
          ? { status: 'checked', findings: r.findings, total: r.total, duration_ms: r.durationMs }
          : { status: 'unavailable', reason: r.reason, duration_ms: r.durationMs };
      await getDb().update(appVersions).set({ typecheck: stored }).where(eq(appVersions.id, version.id));
    })
    .catch((err: unknown) => log.warn('typecheck result not stored', { app_id: version.appId, version_id: version.id, error: dbErrorForLog(err) }));
  return 'pending';
}

function parseStored(raw: unknown): StoredTypecheck | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<StoredTypecheck>;
  if (s.status === 'checked' && Array.isArray((s as { findings?: unknown }).findings)) return s as StoredTypecheck;
  if (s.status === 'unavailable') return s as StoredTypecheck;
  return null;
}

/** The readiness side of a version's check: its state and its type errors as findings. */
export interface VersionTypecheck {
  state?: 'pending' | 'checked' | 'unavailable';
  extra?: { findings: CheckFinding[]; omitted: number };
}

/** The stored check of `version`, or the check scheduled now when it has none yet. */
export async function versionTypecheck(
  version: { id: string; appId: string; compileStatus: string },
  files: ReadonlyMap<string, string | Buffer>,
  log?: Pick<Logger, 'warn'>
): Promise<VersionTypecheck> {
  if (version.compileStatus !== 'ok' || !hasTypeScript(files)) return {};
  const [row] = await getDb().select({ typecheck: appVersions.typecheck }).from(appVersions).where(eq(appVersions.id, version.id)).limit(1);
  const stored = parseStored(row?.typecheck);
  if (stored?.status === 'checked') {
    const findings: CheckFinding[] = stored.findings.map((f) => ({ code: 'type_error', file: f.file, line: f.line, message: f.message }));
    return { state: 'checked', extra: { findings, omitted: Math.max(0, stored.total - findings.length) } };
  }
  if (stored?.status === 'unavailable') return { state: 'unavailable' };
  const scheduled = scheduleVersionTypecheck(version, files, log);
  return scheduled ? { state: scheduled } : {};
}
