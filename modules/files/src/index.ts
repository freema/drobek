/**
 * drobek-module-files — the BUILT-IN platform module `files` (M1-05, §5.5):
 * files the people who use an app upload (photos, PDFs, CSVs).
 *
 *   DROBEK_MODULES=…,files  → this package (`modules/files` in the drobek repo,
 *                             a dependency of the server).
 *
 *   POST   /__drobek/v1/files        multipart/form-data, one file (upload rule)
 *   GET    /__drobek/v1/files        list (admin)
 *   GET    /__drobek/v1/files/:id    the bytes (read rule)
 *   DELETE /__drobek/v1/files/:id    the uploader or an admin
 *   drobek.files.upload(file) / url(id) / remove(id) / list()
 *   config { rules: { upload, read }, maxBytes?, allowedTypes }
 *
 * The bytes live on disk under FILES_DIR (content-addressed, see
 * blob-store.ts); the type comes from the bytes (sniff.ts); a file is served
 * with nosniff, inline only for raster images and PDF. Opening `upload` to
 * `public`, or `read` to `public` while the app holds files, needs the owner's
 * confirmation. Out of scope in v1: image transformations, EXIF stripping,
 * object storage, public galleries.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineModule } from '@drobek/modules';
import { FILES_CONFIG_DEFAULTS, filesConfigSchema, filesConfirmRequired, type FilesConfig } from './config.js';
import { filesAuthority } from './owner.js';
import { DEFAULT_MAX_BYTES, DEFAULT_QUOTA_PER_APP, DEFAULT_UPLOAD_RATE_LIMIT, registerRoutes } from './routes.js';

export { BlobStore, BlobWriter, DEFAULT_FILES_DIR, blobStore, filesDir } from './blob-store.js';
export {
  DEFAULT_ALLOWED_TYPES,
  DEFAULT_FILE_RULES,
  DELETE_RULE,
  FILES_CONFIG_DEFAULTS,
  MAX_CONFIG_BYTES,
  filesConfigSchema,
  filesConfirmRequired,
  type FilesConfig,
} from './config.js';
export { FilesError, filesErrorStatus, type FilesErrorCode } from './errors.js';
export { filesAuthority, ownerFile } from './owner.js';
export {
  DEFAULT_MAX_BYTES,
  DEFAULT_QUOTA_PER_APP,
  DEFAULT_UPLOAD_RATE_LIMIT,
  cleanName,
  contentDisposition,
  effectiveMaxBytes,
  serveHeaders,
  toFile,
} from './routes.js';
export { files, type FileRow } from './schema.js';
export * from './sniff.js';
export { FILE_ID_RE, commitUpload, countFiles, deleteFile, listFiles, loadFile, usedBytes } from './store.js';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** The SDK entry next to this file: dist/sdk.js when built, src/sdk.ts in a source checkout. */
const sdkEntry = existsSync(here('./sdk.js')) ? here('./sdk.js') : here('./sdk.ts');

export const SDK_TYPES = `
/** A stored file. */
export interface StoredFile {
  id: string;
  /** Same-origin URL of the bytes — use it as <img src>, <a href>, <iframe src> (PDF). */
  url: string;
  size: number;
  /** The type drobek detected from the bytes: image/png|jpeg|gif|webp|svg+xml, application/pdf, text/csv. */
  type: string;
  /** The uploaded file's name (the download name). */
  name: string;
  /** The uploader's end-user id (null: an anonymous upload). */
  owner: string | null;
  created_at: string;
}
export interface FilesPage { files: StoredFile[]; next_cursor: string | null; used_bytes: number; quota_bytes: number }
export interface Api {
  /** Upload one file (e.g. from <input type="file">). The signed-in uploader becomes its owner. */
  upload(file: Blob, opts?: { name?: string; signal?: AbortSignal }): Promise<StoredFile>;
  /** The URL of a stored file (store the id, e.g. in a data record; build the URL when rendering). */
  url(id: string): string;
  /** Delete a file (its uploader or an app admin). */
  remove(id: string): Promise<{ id: string; deleted: true }>;
  /** Every file of the app, newest first (app admins only). */
  list(opts?: { limit?: number; cursor?: string | null }): Promise<FilesPage>;
}
`;

const filesModule = defineModule<FilesConfig>({
  name: 'files',
  version: '1.0.0',
  skill: {
    useWhen: 'the user uploads files (photos, avatars, PDFs, CSVs) the app stores and shows or downloads later — instead of Firebase Storage, S3, Cloudinary or UploadThing',
    markdown: readFileSync(here('../SKILL.md'), 'utf8'),
  },
  configSchema: filesConfigSchema,
  configDefaults: FILES_CONFIG_DEFAULTS,
  confirmRequired: filesConfirmRequired,
  rules: {
    ops: {
      upload: 'Upload a file (the signed-in uploader becomes its owner)',
      read: 'Download a file by its id (owner = only the uploader)',
    },
  },
  limits: [
    { env: 'FILES_MAX_BYTES', default: DEFAULT_MAX_BYTES, meaning: 'bytes of one uploaded file (an app config can only lower it)' },
    { env: 'FILES_QUOTA_PER_APP', default: DEFAULT_QUOTA_PER_APP, meaning: 'bytes of files one app may store' },
    { env: 'FILES_UPLOAD_RATE_LIMIT', default: DEFAULT_UPLOAD_RATE_LIMIT, meaning: 'uploads one app may take per minute' },
  ],
  routes: registerRoutes,
  files: filesAuthority,
  sdk: { entry: sdkEntry, types: SDK_TYPES },
  migrations: { folder: here('../migrations') },
});

export default filesModule;
