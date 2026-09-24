/**
 * The files sweep (NSO-325): what the upload and delete paths cannot clean up
 * themselves, removed on a timer in the server process (apps/server jobs):
 *
 *  1. the `mod_files` rows of apps deleted at least RETENTION ago — an app
 *     delete is a soft delete (the row cascade never fires), and a deleted
 *     app's files are unreachable (its hosts answer 404);
 *  2. temp uploads (`<FILES_DIR>/tmp/*.part`) untouched for RETENTION — a
 *     crash between the first chunk and the commit/abort leaves them behind;
 *  3. blobs on disk older than RETENTION (mtime) that NO `mod_files` row of
 *     ANY app references — content of the rows removed in 1., and a blob whose
 *     commit rolled back after its rename.
 *
 * The dedupe rule is the delete path's: a blob is unlinked only under its
 * per-sha256 advisory lock (shared with uploads, see store.ts) and only when
 * a fresh count of the rows with that sha256 is 0 — an upload linking to the
 * same content either committed its row first (the count sees it) or waits
 * for the lock and then writes the bytes again. The age check keeps the sweep
 * away from a blob renamed into place by a commit that is still running.
 *
 * FILES_SWEEP_INTERVAL_MS (1 h) and FILES_SWEEP_RETENTION_MS (24 h) are the
 * operator's; a lease (the server passes a Redis one) keeps it to one replica
 * per interval.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { apps, getDb, type DB } from '@drobek/db';
import { blobStore, type BlobStore } from './blob-store.js';
import { files } from './schema.js';

export const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_SWEEP_RETENTION_MS = 24 * 60 * 60 * 1000;

const HEX2_RE = /^[0-9a-f]{2}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const BATCH = 500;
const LOCK_KEY = 'drobek:lock:files-sweep';

function intEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** FILES_SWEEP_INTERVAL_MS / FILES_SWEEP_RETENTION_MS (production defaults when unset or invalid). */
export function sweepSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): { intervalMs: number; retentionMs: number } {
  return {
    intervalMs: intEnv(env.FILES_SWEEP_INTERVAL_MS, DEFAULT_SWEEP_INTERVAL_MS),
    retentionMs: intEnv(env.FILES_SWEEP_RETENTION_MS, DEFAULT_SWEEP_RETENTION_MS),
  };
}

export interface SweepResult {
  /** `mod_files` rows of long-deleted apps removed. */
  rows: number;
  /** Blobs unlinked (no row of any app references them). */
  blobs: number;
  /** Stale temp uploads removed. */
  tmp: number;
}

async function entries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** mtime in ms, or null when the path is gone or not a regular file. */
async function mtimeOf(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.mtimeMs : null;
  } catch {
    return null;
  }
}

/** Every stored blob (`<root>/ab/cd/<sha256>`) last modified before `cutoff`. */
async function* oldBlobs(store: BlobStore, cutoff: number): AsyncGenerator<string> {
  for (const a of await entries(store.root)) {
    if (!HEX2_RE.test(a)) continue;
    for (const b of await entries(join(store.root, a))) {
      if (!HEX2_RE.test(b)) continue;
      for (const name of await entries(join(store.root, a, b))) {
        if (!SHA256_RE.test(name) || !name.startsWith(a + b)) continue;
        const m = await mtimeOf(join(store.root, a, b, name));
        if (m !== null && m < cutoff) yield name;
      }
    }
  }
}

/** Unlink every blob of `candidates` that no row references (per sha256: advisory lock + a fresh count). */
async function removeUnreferenced(db: DB, store: BlobStore, candidates: string[]): Promise<number> {
  if (candidates.length === 0) return 0;
  const referenced = new Set(
    (await db.selectDistinct({ sha256: files.sha256 }).from(files).where(inArray(files.sha256, candidates))).map((r) => r.sha256)
  );
  let removed = 0;
  for (const sha256 of candidates) {
    if (referenced.has(sha256)) continue;
    const gone = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`drobek:mod_files:blob:${sha256}`}::text))`);
      const [refs] = await tx.select({ n: sql<string>`count(*)` }).from(files).where(eq(files.sha256, sha256));
      if (Number(refs?.n ?? 0) > 0) return false;
      await store.remove(sha256);
      return true;
    });
    if (gone) removed++;
  }
  return removed;
}

/** One sweep (see the file header). `now` and `retentionMs` are injectable for tests. */
export async function sweepFiles(
  db: DB,
  store: BlobStore,
  opts: { retentionMs?: number; now?: number } = {}
): Promise<SweepResult> {
  const now = opts.now ?? Date.now();
  const cutoff = now - (opts.retentionMs ?? DEFAULT_SWEEP_RETENTION_MS);
  const out: SweepResult = { rows: 0, blobs: 0, tmp: 0 };

  // 1. rows of apps deleted before the cutoff (batched; app-scoped by the subquery)
  const deletedApps = db
    .select({ id: apps.id })
    .from(apps)
    .where(and(isNotNull(apps.deletedAt), lt(apps.deletedAt, new Date(cutoff))));
  for (;;) {
    const batch = db.select({ id: files.id }).from(files).where(inArray(files.appId, deletedApps)).limit(BATCH);
    const gone = await db.delete(files).where(inArray(files.id, batch)).returning({ id: files.id });
    out.rows += gone.length;
    if (gone.length < BATCH) break;
  }

  // 2. stale temp uploads
  for (const name of await entries(store.tmpDir)) {
    if (!name.endsWith('.part')) continue;
    const path = join(store.tmpDir, name);
    const m = await mtimeOf(path);
    if (m !== null && m < cutoff) {
      await rm(path, { force: true });
      out.tmp++;
    }
  }

  // 3. old blobs no row references
  let chunk: string[] = [];
  for await (const sha256 of oldBlobs(store, cutoff)) {
    chunk.push(sha256);
    if (chunk.length === BATCH) {
      out.blobs += await removeUnreferenced(db, store, chunk);
      chunk = [];
    }
  }
  out.blobs += await removeUnreferenced(db, store, chunk);
  return out;
}

/** Run `fn` while holding a lease; `{ acquired: false }` when another replica holds it. */
export type SweepLease = <T>(
  key: string,
  ttlSec: number,
  fn: () => Promise<T>
) => Promise<{ acquired: true; result: T } | { acquired: false }>;

/**
 * The periodic sweep in the server process (every FILES_SWEEP_INTERVAL_MS,
 * over FILES_DIR and the app database). Returns a stop function.
 */
export function startFilesSweep(opts: {
  log: (msg: string, err?: unknown) => void;
  lease?: SweepLease;
  env?: NodeJS.ProcessEnv;
}): () => void {
  const { intervalMs, retentionMs } = sweepSettingsFromEnv(opts.env);
  const once = () => sweepFiles(getDb(), blobStore(opts.env), { retentionMs });
  const run = async () => {
    try {
      const out = opts.lease
        ? await opts.lease(LOCK_KEY, Math.max(1, Math.floor(intervalMs / 1000) - 60), once)
        : { acquired: true as const, result: await once() };
      if (out.acquired && out.result.rows + out.result.blobs + out.result.tmp > 0) {
        const r = out.result;
        opts.log(`files sweep: removed ${r.rows} row(s) of deleted apps, ${r.blobs} unreferenced blob(s), ${r.tmp} stale temp upload(s)`);
      }
    } catch (err) {
      opts.log('files sweep failed', err);
    }
  };
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
