/**
 * GET /workspaces/:slug/apps/:appSlug/uploads/:fileId — the bytes of one
 * upload for the Uploads tab (viewer+; another workspace's app → 404),
 * streamed from the files module's `files` authority.
 *
 * The bytes are end-user content served on the DASHBOARD origin, so:
 *  - the type is the one the module SNIFFED from the bytes (never the
 *    client's), with `X-Content-Type-Options: nosniff`;
 *  - only raster images (PNG/JPEG/GIF/WebP) are `inline` (the `<img>`
 *    preview); SVG, PDF and CSV — and anything with `?download=1` — are
 *    `attachment`, so nothing that can run script renders here;
 *  - `Content-Security-Policy: default-src 'none'; sandbox` and
 *    `Cross-Origin-Resource-Policy: same-origin` as defence in depth;
 *  - `Cache-Control: private, no-store` (the tab is behind the session).
 */
import { Readable } from 'node:stream';
import { type LoaderFunctionArgs } from 'react-router';
import { requireWorkspaceRole } from '@drobek/tenancy';
import { filesOf, ownerApp } from '../owner-http.server.js';
import { PREVIEW_TYPES, safeFilename } from '../owner-view.js';

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'text/csv': 'csv',
};

function notFound(): Response {
  return new Response('not found\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export async function loader({ request, params }: LoaderFunctionArgs): Promise<Response> {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'viewer');
  const app = await ownerApp(access, String(params.appSlug ?? ''));
  const files = await filesOf(app);
  const id = String(params.fileId ?? '');
  if (!files || !/^[a-z0-9]{8,64}$/.test(id)) return notFound();
  const opened = await files.open(id);
  if (!opened) return notFound();
  const { file, stream } = opened;

  const download = new URL(request.url).searchParams.get('download') === '1';
  const inline = !download && PREVIEW_TYPES.has(file.type);
  const known = Object.prototype.hasOwnProperty.call(EXT, file.type);
  const name = safeFilename(file.name, `file-${file.id}.${known ? EXT[file.type] : 'bin'}`);
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    status: 200,
    headers: {
      'Content-Type': !known ? 'application/octet-stream' : file.type === 'text/csv' ? 'text/csv; charset=utf-8' : file.type,
      'Content-Length': String(file.size),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'private, no-store',
    },
  });
}
