/**
 * GET /gallery/open/:slug — the gallery's counting link (NSO-340), on the
 * DASHBOARD host, no login. `GET /api/public/gallery` hands it out as each
 * entry's `openUrl`; it counts one open of the app for the current UTC day
 * and answers 302 to the app's production URL.
 *
 * Not counted, still redirected: a browser prefetch or preview
 * (`Sec-Purpose` / `Purpose` / `X-Moz` / `X-Purpose`), a HEAD request, and
 * more than GALLERY_OPENS_PER_IP_HOUR counted opens from one client IP in an
 * hour (default 60; skipped without a resolved client IP; a Redis failure
 * counts). Nothing about the visitor is stored. An app the gallery does not
 * show (or GALLERY_ENABLED off) → 404.
 */
import { type LoaderFunctionArgs } from 'react-router';
import { galleryEnabled, galleryEntryBySlug, isPrefetchRequest, recordGalleryOpen } from '@drobek/apps';
import { getClientIp, rateLimitRedis } from '@drobek/auth';
import { createConsoleLogger, perIpLimitKey } from '@drobek/core';
import { dbErrorForLog } from '@drobek/db';

const log = createConsoleLogger('gallery');

export const GALLERY_OPENS_RATE_BUCKET = 'gallery-open-ip';
const HOUR_MS = 60 * 60 * 1000;

/** Counted opens per client IP per hour. */
export function galleryOpensPerIpHour(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.GALLERY_OPENS_PER_IP_HOUR);
  return Number.isInteger(n) && n > 0 ? n : 60;
}

async function withinLimit(request: Request): Promise<boolean> {
  const key = perIpLimitKey(getClientIp(request), GALLERY_OPENS_RATE_BUCKET);
  if (key === null) return true;
  try {
    return (await rateLimitRedis(GALLERY_OPENS_RATE_BUCKET, key, galleryOpensPerIpHour(), HOUR_MS)).ok;
  } catch (err) {
    log.warn('gallery open rate limit unavailable — counted', { error: err instanceof Error ? err.name : 'unknown' });
    return true;
  }
}

function notFound(): Response {
  return new Response('This app is not in the gallery.', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
}

export async function loader({ request, params }: LoaderFunctionArgs): Promise<Response> {
  if (!galleryEnabled()) return notFound();
  const entry = await galleryEntryBySlug(String(params.slug ?? ''));
  if (!entry) return notFound();
  if (request.method.toUpperCase() === 'GET' && !isPrefetchRequest(request.headers) && (await withinLimit(request))) {
    try {
      await recordGalleryOpen(entry.id);
    } catch (err) {
      log.error('gallery open not counted', { app_id: entry.id, error: dbErrorForLog(err) });
    }
  }
  return new Response(null, {
    status: 302,
    headers: { Location: entry.url, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' },
  });
}
