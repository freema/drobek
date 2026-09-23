/**
 * The OWNER's view of an app's uploads (the `files` authority — the dashboard
 * Uploads tab, M2-03). Core calls it only after it authorized a drobek account
 * for the app, so it bypasses the `read` rule and the `owner|admin` delete
 * rule of the REST routes; every statement is still scoped to the ONE app of
 * the view. A delete follows the same blob rule as the module's own route:
 * the bytes go only when no row of ANY app references that content any more.
 */
import type { FilesAuthority, OwnerFile } from '@drobek/modules';
import { blobStore } from './blob-store.js';
import type { FilesConfig } from './config.js';
import { DEFAULT_QUOTA_PER_APP } from './routes.js';
import type { FileRow } from './schema.js';
import { decodeCursor, deleteFile, encodeCursor, listFiles, loadFile, usedBytes } from './store.js';

export function ownerFile(row: FileRow): OwnerFile {
  return { id: row.id, name: row.name, type: row.type, size: row.size, owner: row.ownerId, created_at: row.createdAt.toISOString() };
}

function positive(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export const filesAuthority: FilesAuthority<FilesConfig> = {
  async list(view, q) {
    const limit = Math.min(200, Math.max(1, Math.floor(Number(q.limit ?? 50)) || 50));
    const page = await listFiles(view.db, view.app.id, { limit, cursor: decodeCursor(q.cursor ?? undefined) });
    return {
      files: page.rows.map(ownerFile),
      next_cursor: page.next ? encodeCursor(page.next) : null,
      used_bytes: await usedBytes(view.db, view.app.id),
      quota_bytes: positive((await view.limits()).FILES_QUOTA_PER_APP, DEFAULT_QUOTA_PER_APP),
    };
  },

  async open(view, id) {
    const row = await loadFile(view.db, view.app.id, id);
    if (!row) return null;
    const stream = await blobStore().open(row.sha256);
    if (!stream) {
      view.log.error('files: stored blob is missing', { app_id: view.app.id, id: row.id, sha256: row.sha256 });
      return null;
    }
    return { file: ownerFile(row), stream };
  },

  async remove(view, id) {
    const row = await loadFile(view.db, view.app.id, id);
    if (!row) return false;
    return deleteFile(view.db, blobStore(), view.app.id, row);
  },
};
