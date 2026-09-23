/**
 * `mod_files` reads and writes + the blob bookkeeping around them. EVERY
 * statement that reads or changes a row is scoped by the app id the caller
 * passes (the runtime scoped the request to ONE app); only the blob reference
 * count looks across apps — by sha256, never returning another app's rows.
 *
 * Two transaction-scoped advisory locks keep disk and database consistent
 * under concurrency:
 *  - `app` lock: one upload commit per app at a time, so the quota
 *    (FILES_QUOTA_PER_APP, the sum of the app's file sizes) holds exactly;
 *  - `blob` lock (per sha256): an upload that links to stored content and a
 *    delete that drops the last reference to it never interleave — a delete
 *    unlinks the blob only when NO row of ANY app references it any more.
 * Lock order is always app → blob (a delete takes only the blob lock).
 */
import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { DB } from '@drobek/db';
import type { BlobStore, BlobWriter } from './blob-store.js';
import { FilesError } from './errors.js';
import { files, type FileRow } from './schema.js';
import type { FileType } from './sniff.js';

type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

export const FILE_ID_RE = /^[a-z0-9]{8,64}$/;

async function lock(tx: Tx, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}::text))`);
}

/** Bytes stored by one app (the quota sums them — per row, even when content is shared). */
export async function usedBytes(db: DB | Tx, appId: string): Promise<number> {
  const [row] = await db
    .select({ b: sql<string>`coalesce(sum(${files.size}), 0)` })
    .from(files)
    .where(eq(files.appId, appId));
  return Number(row?.b ?? 0);
}

export async function countFiles(db: DB, appId: string): Promise<number> {
  const [row] = await db.select({ n: sql<string>`count(*)` }).from(files).where(eq(files.appId, appId));
  return Number(row?.n ?? 0);
}

export async function loadFile(db: DB, appId: string, id: string): Promise<FileRow | null> {
  if (!FILE_ID_RE.test(id)) return null;
  const [row] = await db
    .select()
    .from(files)
    .where(and(eq(files.appId, appId), eq(files.id, id)))
    .limit(1);
  return row ?? null;
}

export interface NewFile {
  appId: string;
  ownerId: string | null;
  type: FileType;
  name: string;
  size: number;
  sha256: string;
  quotaBytes: number;
}

/**
 * Store a finished upload: under the app lock check the quota, then under the
 * blob lock insert the row and move the bytes into place (the row is rolled
 * back when the move fails). Throws `quota_exceeded`.
 */
export async function commitUpload(db: DB, writer: BlobWriter, input: NewFile): Promise<FileRow> {
  return db.transaction(async (tx) => {
    await lock(tx, `drobek:mod_files:app:${input.appId}`);
    const used = await usedBytes(tx, input.appId);
    if (used + input.size > input.quotaBytes) {
      throw new FilesError('quota_exceeded', `This upload would exceed the app's storage limit of ${input.quotaBytes} bytes (${used} used).`, {
        details: { limit: 'FILES_QUOTA_PER_APP', value: input.quotaBytes, used },
      });
    }
    await lock(tx, `drobek:mod_files:blob:${input.sha256}`);
    const [row] = await tx
      .insert(files)
      .values({
        id: createId(),
        appId: input.appId,
        sha256: input.sha256,
        size: input.size,
        type: input.type,
        name: input.name,
        ownerId: input.ownerId,
        // Millisecond precision (JS), so the list cursor compares exactly.
        createdAt: new Date(),
      })
      .returning();
    await writer.commit(input.sha256);
    return row;
  });
}

/**
 * Delete one file of an app; its blob goes too when no other row (of any app)
 * references the same content. False when the file did not exist.
 */
export async function deleteFile(db: DB, store: BlobStore, appId: string, row: Pick<FileRow, 'id' | 'sha256'>): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lock(tx, `drobek:mod_files:blob:${row.sha256}`);
    const gone = await tx
      .delete(files)
      .where(and(eq(files.appId, appId), eq(files.id, row.id)))
      .returning({ id: files.id });
    if (gone.length === 0) return false;
    const [refs] = await tx.select({ n: sql<string>`count(*)` }).from(files).where(eq(files.sha256, row.sha256));
    if (Number(refs?.n ?? 0) === 0) await store.remove(row.sha256);
    return true;
  });
}

export interface ListCursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(c: ListCursor): string {
  return Buffer.from(JSON.stringify([c.createdAt, c.id]), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): ListCursor | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' && !Number.isNaN(Date.parse(v[0])) && FILE_ID_RE.test(v[1])) {
      return { createdAt: v[0], id: v[1] };
    }
  } catch {
    /* fall through */
  }
  throw new FilesError('invalid_request', 'The cursor is invalid — pass next_cursor from the previous page.');
}

/** A page of an app's files, newest first. */
export async function listFiles(db: DB, appId: string, opts: { limit: number; cursor: ListCursor | null }): Promise<{ rows: FileRow[]; next: ListCursor | null }> {
  const after = opts.cursor
    ? or(
        lt(files.createdAt, new Date(opts.cursor.createdAt)),
        and(eq(files.createdAt, new Date(opts.cursor.createdAt)), lt(files.id, opts.cursor.id))
      )
    : undefined;
  const rows = await db
    .select()
    .from(files)
    .where(after ? and(eq(files.appId, appId), after) : eq(files.appId, appId))
    .orderBy(desc(files.createdAt), desc(files.id))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  return { rows: page, next: rows.length > opts.limit && last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null };
}
