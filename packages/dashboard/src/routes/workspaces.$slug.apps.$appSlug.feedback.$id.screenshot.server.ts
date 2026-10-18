/**
 * GET /workspaces/:slug/apps/:appSlug/feedback/:id/screenshot — the
 * screenshot attached to one feedback note, for the Feedback tab (viewer+;
 * another workspace's app, an unknown note and a note without a screenshot
 * all answer 404). `?size=thumb` answers a smaller WebP for the list.
 *
 * The bytes are drobek's own re-encoding of what a member uploaded (a WebP,
 * never the original), still served on the DASHBOARD origin with
 * `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src
 * 'none'; sandbox` and `Cross-Origin-Resource-Policy: same-origin`. The
 * ETag is the image's sha256: `Cache-Control: private, no-cache` keeps the
 * browser asking (a deleted note answers 404 at once) while an unchanged
 * image answers 304 without being read or resized.
 */
import { type LoaderFunctionArgs } from 'react-router';
import { getFeedback, getFeedbackScreenshot, isFeedbackId, reencodeImage } from '@drobek/apps';
import { requireWorkspaceRole } from '@drobek/tenancy';
import { ownerApp } from '../owner-http.server.js';

/** The longer side of the Feedback tab's thumbnail, in pixels. */
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
  if (!isFeedbackId(id)) return notFound();
  const thumb = new URL(request.url).searchParams.get('size') === 'thumb';
  const note = await getFeedback(app.id, id);
  if (!note?.screenshot) return notFound();
  const etag = `"${note.screenshot.sha256}${thumb ? '-thumb' : ''}"`;
  if ((request.headers.get('if-none-match') ?? '').split(',').some((t) => t.trim() === etag)) {
    return new Response(null, { status: 304, headers: { ...HEADERS, ETag: etag } });
  }
  const shot = await getFeedbackScreenshot(app.id, id);
  if (!shot) return notFound();
  const bytes = thumb
    ? (await reencodeImage(shot.data, { maxSide: SCREENSHOT_THUMB_SIDE, maxBytes: THUMB_MAX_BYTES, format: 'webp' })).bytes
    : shot.data;
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      ...HEADERS,
      'Content-Type': 'image/webp',
      'Content-Length': String(bytes.length),
      'Content-Disposition': `inline; filename="feedback-${id}${thumb ? '-thumb' : ''}.webp"`,
      ETag: etag,
    },
  });
}
