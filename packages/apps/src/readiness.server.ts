/**
 * The publish readiness report of a STORED version (NSO-384) — what publish
 * returns and the dashboard's app page shows. The same @drobek/compile
 * `readinessReport` write_files runs over its in-memory files: blocking = the
 * version's stored compile errors, warnings = the registered checks over its
 * source files (never executed) and the app's module configs.
 */
import {
  TEXT_EXTS,
  readinessReport,
  type BlockingMessage,
  type ReadinessOptions,
  type ReadinessReport,
} from '@drobek/compile';
import { getVersion, readBlobs } from './versions.server.js';
import type { VersionDetail } from './types.js';

function extOf(path: string): string {
  const i = path.lastIndexOf('.');
  return i <= path.lastIndexOf('/') ? '' : path.slice(i).toLowerCase();
}

/** A version's source files: text as string, binary assets as Buffer. */
export async function versionSources(version: Pick<VersionDetail, 'files'>): Promise<Map<string, string | Buffer>> {
  const sources = version.files.filter((f) => f.kind === 'source');
  const blobs = await readBlobs(sources.map((f) => f.sha256));
  const out = new Map<string, string | Buffer>();
  for (const f of sources) {
    const bytes = blobs.get(f.sha256);
    if (!bytes) continue;
    out.set(f.path, TEXT_EXTS.has(extOf(f.path)) ? bytes.toString('utf8') : bytes);
  }
  return out;
}

/** The stored compile outcome as blocking messages: none for `ok`, at least one otherwise. */
function storedBlocking(version: Pick<VersionDetail, 'compileStatus' | 'compileErrors'>): BlockingMessage[] {
  if (version.compileStatus === 'ok') return [];
  const stored = Array.isArray(version.compileErrors) ? (version.compileErrors as BlockingMessage[]) : [];
  if (stored.length > 0) return stored;
  return [
    {
      code: 'compile_error',
      text: version.compileStatus === 'pending' ? 'This version has not been built.' : 'This version did not compile.',
    },
  ];
}

export type VersionReadinessOptions = Omit<ReadinessOptions, 'files' | 'blocking'>;

/** The report of version `ref` of `appId`, or null when it does not exist. */
export async function versionReadiness(
  appId: string,
  ref: { number: number } | { id: string },
  opts: VersionReadinessOptions = {}
): Promise<{ version: number; report: ReadinessReport } | null> {
  const version = await getVersion(appId, ref);
  if (!version) return null;
  const report = await readinessReport({ ...opts, files: await versionSources(version), blocking: storedBlocking(version) });
  return { version: version.number, report };
}
