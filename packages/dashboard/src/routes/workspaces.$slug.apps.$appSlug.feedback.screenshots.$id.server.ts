/**
 * GET /workspaces/:slug/apps/:appSlug/feedback/screenshots/:id — a screenshot
 * someone sent from the preview when an agent asked for one
 * (request_screenshot), for the Feedback tab (viewer+; another workspace's
 * app and an unknown or expired screenshot answer 404). `?size=thumb`
 * answers a smaller WebP for the list.
 *
 * The bytes are drobek's own re-encoding of the capture (a WebP, never the
 * original), served on the DASHBOARD origin with `X-Content-Type-Options:
 * nosniff`, `Content-Security-Policy: default-src 'none'; sandbox` and
 * `Cross-Origin-Resource-Policy: same-origin`. A screenshot never changes
 * under its id, so the id is the ETag.
 */
import { type LoaderFunctionArgs } from 'react-router';
import { getAppScreenshot, isScreenshotRequestId, reencodeImage } from '@drobek/apps';
import { requireWorkspaceRole } from '@drobek/tenancy';
import { ownerApp } from '../owner-http.server.js';

const SCREENSHOT_THUMB_SIDE = 480;
const THUMB_MAX_BYTES = 256 * 1024;

const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'private, no-cache',
};

function notFound(): Response {
  return new Response('not found\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export async function loader({ request, params }: LoaderFunctionArgs): Promise<Response> {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'viewer');
  const app = await ownerApp(access, String(params.appSlug ?? ''));
  const id = String(params.id ?? '');
  if (!isScreenshotRequestId(id)) return notFound();
  const thumb = new URL(request.url).searchParams.get('size') === 'thumb';
  const etag = `"${id}${thumb ? '-thumb' : ''}"`;
  const shot = await getAppScreenshot(app.id, id);
  if (!shot) return notFound();
  if ((request.headers.get('if-none-match') ?? '').split(',').some((t) => t.trim() === etag)) {
    return new Response(null, { status: 304, headers: { ...HEADERS, ETag: etag } });
  }
  const bytes = thumb
    ? (await reencodeImage(shot.data, { maxSide: SCREENSHOT_THUMB_SIDE, maxBytes: THUMB_MAX_BYTES, format: 'webp' })).bytes
    : shot.data;
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      ...HEADERS,
      'Content-Type': 'image/webp',
      'Content-Length': String(bytes.length),
      'Content-Disposition': `inline; filename="screenshot-${id}${thumb ? '-thumb' : ''}.webp"`,
      ETag: etag,
    },
  });
}
