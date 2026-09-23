/**
 * `/__drobek/v1/files/…` on every app host (the preview and production hosts
 * of an app share its files):
 *
 *   POST   /      multipart/form-data, ONE file → 201 { id, url, size, type, name, created_at }   (upload)
 *   GET    /      → { files, next_cursor, used_bytes, quota_bytes }                               (admin)
 *   GET    /:id   → the bytes                                                                    (read)
 *   DELETE /:id   → { id, deleted: true }                                                        (owner|admin)
 *
 * An upload, in order: the `upload` rule → the per-app upload rate limit →
 * the declared Content-Length and the app's quota (early refusals, nothing
 * read) → the file streams to a temp file while it is counted (past the
 * per-file cap: 413, the rest of the request is discarded, the temp file
 * removed), hashed and sniffed (not an accepted type: 415 `unsupported_type`)
 * → the quota again, exactly, under the app lock → the row + the bytes at
 * their content address. Every failure removes the temp file.
 *
 * A download sends the SNIFFED type with `X-Content-Type-Options: nosniff`;
 * only raster images and PDF are `inline`, SVG and CSV are always
 * `attachment` (an SVG opened inline would run its scripts on the app's
 * origin). The ETag is the content's sha256 (304 on If-None-Match);
 * `read: public` files are `immutable` for a year, others `private, no-cache`
 * (revalidated, so a sign-out or a rule change applies at once).
 */
import { MAX_FILE_HEAD_BYTES, decideAccess, respond, z, type ModuleContext, type ModuleRequest, type ModuleRouter, type Principal } from '@drobek/modules';
import { blobStore } from './blob-store.js';
import { DELETE_RULE, type FilesConfig } from './config.js';
import { FilesError } from './errors.js';
import { TypeSniffer, extensionOf, typeAllowed, type FileType } from './sniff.js';
import { FILE_ID_RE, commitUpload, decodeCursor, deleteFile, encodeCursor, listFiles, loadFile, usedBytes } from './store.js';
import type { FileRow } from './schema.js';

type Ctx = ModuleContext<FilesConfig>;

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB per file
export const DEFAULT_QUOTA_PER_APP = 500 * 1024 * 1024; // 500 MiB per app
export const DEFAULT_UPLOAD_RATE_LIMIT = 60; // uploads per minute per app
export const UPLOAD_RATE_WINDOW_MS = 60_000;
/** Multipart framing on top of the file a declared Content-Length may carry. */
const FRAMING_ALLOWANCE = MAX_FILE_HEAD_BYTES + 1024;

const INLINE_TYPES = new Set<string>(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'private, no-cache';

function positive(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** The per-file cap for this app: the operator's FILES_MAX_BYTES, lowered by the config's maxBytes. */
export function effectiveMaxBytes(limits: Readonly<Record<string, number>>, config: FilesConfig): number {
  const operator = positive(limits.FILES_MAX_BYTES, DEFAULT_MAX_BYTES);
  return config.maxBytes !== undefined ? Math.min(operator, config.maxBytes) : operator;
}

/** The client's file name as a harmless download name: no path, no control characters, ≤ 200 characters. */
export function cleanName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f"]/g, '').trim().slice(0, 200);
}

/** `Content-Disposition` with an ASCII fallback and the UTF-8 name (RFC 6266 / 5987). */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"%;]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** What a download answers with (without the body). */
export function serveHeaders(row: Pick<FileRow, 'id' | 'sha256' | 'size' | 'type' | 'name'>, readRule: string): Record<string, string> {
  const type = row.type as FileType;
  const name = row.name || `file-${row.id}.${extensionOf(type)}`;
  return {
    'Content-Type': type === 'text/csv' ? 'text/csv; charset=utf-8' : type,
    'Content-Length': String(row.size),
    'Content-Disposition': contentDisposition(INLINE_TYPES.has(type) ? 'inline' : 'attachment', name),
    'X-Content-Type-Options': 'nosniff',
    ETag: `"${row.sha256}"`,
    'Cache-Control': decideAccess(readRule, { kind: 'anon' }).ok ? IMMUTABLE : REVALIDATE,
  };
}

/** A file as the API returns it. */
export function toFile(row: FileRow): { id: string; url: string; size: number; type: string; name: string; owner: string | null; created_at: string } {
  return {
    id: row.id,
    url: `/__drobek/v1/files/${row.id}`,
    size: row.size,
    type: row.type,
    name: row.name,
    owner: row.ownerId,
    created_at: row.createdAt.toISOString(),
  };
}

function deny(status: 401 | 403, what: string, rule: string): never {
  if (status === 401) throw new FilesError('unauthorized', `Sign in to this app first: only signed-in users may ${what} (rule: "${rule}").`);
  throw new FilesError('forbidden', `You may not ${what} (rule: "${rule}").`);
}

const ownerOf = (p: Principal) => (p.kind === 'user' ? p.id : null);

const listQuery = z.object({
  limit: z.string().regex(/^\d{1,3}$/).optional(),
  cursor: z.string().max(512).optional(),
});

async function upload(req: ModuleRequest<unknown>, ctx: Ctx) {
  const { config, principal } = ctx;
  // `owner` admits the uploader (they become the owner), like data's create.
  const allowed = decideAccess(config.rules.upload, principal, ownerOf(principal));
  if (!allowed.ok) deny(allowed.status, 'upload files to this app', config.rules.upload);

  const limits = await ctx.limits();
  const rate = positive(limits.FILES_UPLOAD_RATE_LIMIT, DEFAULT_UPLOAD_RATE_LIMIT);
  const rl = await ctx.rateLimit('uploads', 'app', rate, UPLOAD_RATE_WINDOW_MS);
  if (!rl.ok) {
    throw new FilesError('rate_limited', `Too many uploads for this app (${rate} per minute). Slow down and retry.`, {
      details: { limit: 'FILES_UPLOAD_RATE_LIMIT', value: rate },
      headers: { 'Retry-After': String(rl.retryAfterSec) },
    });
  }

  const maxBytes = effectiveMaxBytes(limits, config);
  const tooLarge = () =>
    new FilesError('payload_too_large', `The file is larger than ${maxBytes} bytes — the most one file may have here.`, {
      details: { limit: config.maxBytes !== undefined && config.maxBytes < positive(limits.FILES_MAX_BYTES, DEFAULT_MAX_BYTES) ? 'maxBytes' : 'FILES_MAX_BYTES', value: maxBytes },
    });
  const declared = Number(req.header('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes + FRAMING_ALLOWANCE) throw tooLarge();

  const quota = positive(limits.FILES_QUOTA_PER_APP, DEFAULT_QUOTA_PER_APP);
  const used = await usedBytes(ctx.db, ctx.app.id);
  if (used >= quota) {
    throw new FilesError('quota_exceeded', `This app has used its storage limit of ${quota} bytes.`, {
      details: { limit: 'FILES_QUOTA_PER_APP', value: quota, used },
    });
  }

  const file = await req.file();
  const store = blobStore();
  const writer = store.begin();
  const sniffer = new TypeSniffer();
  try {
    let size = 0;
    for await (const chunk of file.stream) {
      size += chunk.length;
      if (size > maxBytes) throw tooLarge(); // leaving the loop discards the rest of the request
      sniffer.update(chunk);
      if (sniffer.rejected) throw unsupported(config);
      await writer.write(chunk);
    }
    if (size === 0) throw new FilesError('invalid_request', 'The file is empty.');
    const type = sniffer.finish(file.declaredType, file.filename);
    if (!type || !typeAllowed(type, config.allowedTypes)) throw unsupported(config, type);
    const sha256 = await writer.finish();
    const row = await commitUpload(ctx.db, writer, {
      appId: ctx.app.id,
      ownerId: ownerOf(principal),
      type,
      name: cleanName(file.filename),
      size,
      sha256,
      quotaBytes: quota,
    });
    await ctx.audit('upload', { id: row.id, size, type });
    return respond(201, toFile(row));
  } finally {
    await writer.abort();
  }
}

function unsupported(config: FilesConfig, type?: FileType | null): FilesError {
  return new FilesError(
    'unsupported_type',
    type
      ? `This app does not accept ${type} files (allowedTypes: ${config.allowedTypes.join(', ')}).`
      : `The file's content is not an accepted type: PNG, JPEG, GIF, WebP, SVG, PDF or CSV (decided from the bytes, not the name or the declared type).`,
    { details: { allowed: config.allowedTypes, ...(type ? { type } : {}) } }
  );
}

export function registerRoutes(r: ModuleRouter<FilesConfig>): void {
  r.post('/', { bodyTypes: ['file'] }, upload);

  r.get('/', { rule: 'admin', query: listQuery }, async (req, ctx) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
    const page = await listFiles(ctx.db, ctx.app.id, { limit, cursor: decodeCursor(req.query.cursor) });
    const limits = await ctx.limits();
    return {
      files: page.rows.map(toFile),
      next_cursor: page.next ? encodeCursor(page.next) : null,
      used_bytes: await usedBytes(ctx.db, ctx.app.id),
      quota_bytes: positive(limits.FILES_QUOTA_PER_APP, DEFAULT_QUOTA_PER_APP),
    };
  });

  r.get('/:id', async (req, ctx) => {
    const rule = ctx.config.rules.read;
    // A visitor the rule can never admit gets 401 before any lookup (no probing ids).
    const pre = decideAccess(rule, ctx.principal, null);
    if (!pre.ok && pre.status === 401) deny(401, 'download files of this app', rule);
    const id = req.params.id;
    const row = FILE_ID_RE.test(id) ? await loadFile(ctx.db, ctx.app.id, id) : null;
    if (!row) throw new FilesError('not_found', 'No such file.');
    const d = decideAccess(rule, ctx.principal, row.ownerId);
    if (!d.ok) deny(d.status, 'download this file', rule);

    const headers = serveHeaders(row, rule);
    const inm = req.header('if-none-match');
    if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === headers.ETag)) {
      const { 'Content-Length': _omit, ...rest } = headers;
      void _omit;
      return respond(304, null, rest);
    }
    if (req.method === 'HEAD') return respond(200, null, headers);
    const stream = await blobStore().open(row.sha256);
    if (!stream) {
      ctx.log.error('files: stored blob is missing', { app_id: ctx.app.id, id: row.id, sha256: row.sha256 });
      throw new FilesError('not_found', 'No such file.');
    }
    return respond(200, stream, headers);
  });

  r.delete('/:id', async (req, ctx) => {
    const pre = decideAccess(DELETE_RULE, ctx.principal, null);
    if (!pre.ok && pre.status === 401) deny(401, 'delete files of this app', DELETE_RULE);
    const row = await loadFile(ctx.db, ctx.app.id, req.params.id);
    if (!row) throw new FilesError('not_found', 'No such file.');
    const d = decideAccess(DELETE_RULE, ctx.principal, row.ownerId);
    if (!d.ok) deny(d.status, 'delete this file (only its uploader or an app admin may)', DELETE_RULE);
    if (!(await deleteFile(ctx.db, blobStore(), ctx.app.id, row))) throw new FilesError('not_found', 'No such file.');
    await ctx.audit('delete', { id: row.id, size: row.size, type: row.type });
    return { id: row.id, deleted: true };
  });
}
