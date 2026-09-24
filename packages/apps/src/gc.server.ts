/**
 * Blob garbage collection. A blob is deleted only when NO version references
 * it AND it is older than the grace period (default 7 days) — the grace
 * covers a write that stored blobs moments before its version row. The FK
 * `version_files.sha256 → blobs` makes deleting a referenced blob impossible,
 * and `createVersion` refreshes + row-locks every blob it reuses.
 */
import { sql } from 'drizzle-orm';
import { dbErrorForLog, getDb } from '@drobek/db';
import { withRedisLock } from './lock.server.js';

export const BLOB_GC_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const BLOB_GC_INTERVAL_MS = 60 * 60 * 1000;
const BATCH = 500;
const LOCK_KEY = 'drobek:lock:blob-gc';

/** Delete unreferenced blobs older than `graceMs`; returns how many went. */
export async function sweepUnreferencedBlobs(
  opts: { graceMs?: number } = {}
): Promise<{ deleted: number }> {
  const graceSec = Math.floor((opts.graceMs ?? BLOB_GC_GRACE_MS) / 1000);
  let deleted = 0;
  for (;;) {
    // Candidates are row-locked (SKIP LOCKED: a blob a concurrent write is
    // upserting is left alone), and the grace + unreferenced conditions are
    // repeated on the DELETE target so they are re-checked against the
    // latest row version, not only the subquery's snapshot.
    const rows = await getDb().execute<{ sha256: string }>(sql`
      DELETE FROM blobs WHERE sha256 IN (
        SELECT b.sha256 FROM blobs b
        WHERE b.created_at < now() - make_interval(secs => ${graceSec})
          AND NOT EXISTS (SELECT 1 FROM version_files vf WHERE vf.sha256 = b.sha256)
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED
      )
        AND created_at < now() - make_interval(secs => ${graceSec})
        AND NOT EXISTS (SELECT 1 FROM version_files vf WHERE vf.sha256 = blobs.sha256)
      RETURNING sha256`);
    const n = Array.isArray(rows) ? rows.length : ((rows as { rows?: unknown[] }).rows?.length ?? 0);
    deleted += n;
    if (n < BATCH) return { deleted };
  }
}

/**
 * Hourly sweep in the server process. A Redis lease makes sure only one
 * replica sweeps per hour. Returns a stop function.
 */
export function startBlobGc(log: (msg: string, error?: string) => void): () => void {
  const run = async () => {
    try {
      const out = await withRedisLock(LOCK_KEY, Math.floor(BLOB_GC_INTERVAL_MS / 1000) - 60, () =>
        sweepUnreferencedBlobs()
      );
      if (out.acquired && out.result.deleted > 0) {
        log(`blob gc: deleted ${out.result.deleted} unreferenced blob(s)`);
      }
    } catch (err) {
      log('blob gc failed', dbErrorForLog(err));
    }
  };
  const timer = setInterval(() => void run(), BLOB_GC_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
