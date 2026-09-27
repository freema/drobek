/**
 * GET /api/public/gallery — the public gallery list (NSO-340), on the
 * DASHBOARD host, no login. The operator's website renders it (drobek.app:
 * www.drobek.app/gallery, through its own proxy or straight from the
 * browser).
 *
 *   cursor mode (default):  200 { items: [{ name, description, url, publishedAt, modules }], next? }
 *   page mode:              200 { items: [...], page, pages, total, previews }
 *
 * `url` is the production host `https://<slug>.<APPS_DOMAIN>`; `?limit` 1–48
 * (default 24); `?q` = case- and accent-insensitive substring of the name or the
 * description (trimmed, at most 100 characters; `%` `_` `\` match
 * themselves); `?sort` = `new` (newest publish first, the default) or `name`
 * (A→Z). Cursor mode (`sort=new` without `page`, or with a `cursor`):
 * `?cursor` = the previous page's `next`. Page mode (`?page=<n>` 1-based
 * without a cursor, and always with `sort=name` — a cursor is ignored there):
 * `pages` / `total` count the filtered list; an invalid page is page 1, a
 * page past the last has no items. `previews` = GALLERY_FRAME_ANCESTORS is
 * set, so a listed app's production host may be framed by the gallery.
 * Only apps whose owner listed them AND that are published, public (no
 * password gate), not taken down, not deleted and not hidden by a super-admin
 * (@drobek/apps listGallery filters at query time). No owner data: no
 * e-mail, workspace, user or app id. `modules` contains only names with a
 * non-empty saved config, never config values or pending proposals; it does
 * not claim that a configured module is currently enabled or used.
 *
 * Read-only public data: `Access-Control-Allow-Origin: *`,
 * `Cache-Control: public, max-age=60`. Per client IP at most
 * GALLERY_API_PER_IP_MINUTE requests a minute (default 60 → 429 +
 * Retry-After; skipped without a resolved client IP; a Redis failure lets
 * the request through — the list is public anyway). GALLERY_ENABLED off
 * (the default) → 404.
 */
import { type LoaderFunctionArgs } from 'react-router';
import { galleryEnabled, galleryPageNumber, galleryPageSize, gallerySort, listGallery, listGalleryPage } from '@drobek/apps';
import { getClientIp, rateLimitRedis } from '@drobek/auth';
import { createConsoleLogger, perIpLimitKey } from '@drobek/core';
import { galleryFrameAncestorsFromEnv } from '@drobek/serving';

const log = createConsoleLogger('gallery');

export const GALLERY_RATE_BUCKET = 'gallery-api-ip';
const MINUTE_MS = 60 * 1000;

/** Requests per client IP per minute. */
export function galleryRequestsPerIpMinute(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.GALLERY_API_PER_IP_MINUTE);
  return Number.isInteger(n) && n > 0 ? n : 60;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD',
  'X-Content-Type-Options': 'nosniff',
};

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...CORS, 'Cache-Control': 'no-store', ...headers } });
}

async function withinLimit(request: Request): Promise<boolean> {
  const key = perIpLimitKey(getClientIp(request), GALLERY_RATE_BUCKET);
  if (key === null) return true;
  try {
    return (await rateLimitRedis(GALLERY_RATE_BUCKET, key, galleryRequestsPerIpMinute(), MINUTE_MS)).ok;
  } catch (err) {
    log.warn('gallery rate limit unavailable — request allowed', { error: err instanceof Error ? err.name : 'unknown' });
    return true;
  }
}

export async function loader({ request }: LoaderFunctionArgs): Promise<Response> {
  if (!galleryEnabled()) {
    return json({ error: 'not_found', message: 'This server has no public gallery.' }, 404);
  }
  if (!(await withinLimit(request))) {
    return json(
      { error: 'rate_limited', message: 'Too many requests from your network. Try again in a minute.' },
      429,
      { 'Retry-After': '60' }
    );
  }
  const params = new URL(request.url).searchParams;
  const limit = galleryPageSize(params.get('limit'));
  const q = params.get('q');
  const sort = gallerySort(params.get('sort'));
  const cursor = params.get('cursor');
  const pageNumber = galleryPageNumber(params.get('page'));
  const cache = { 'Cache-Control': 'public, max-age=60' };
  if (sort === 'name' || (pageNumber !== null && !cursor)) {
    const previews = galleryFrameAncestorsFromEnv().length > 0;
    return json({ ...(await listGalleryPage({ limit, page: pageNumber ?? 1, q, sort })), previews }, 200, cache);
  }
  const page = await listGallery({ limit, cursor, q });
  return json(page.next ? { items: page.items, next: page.next } : { items: page.items }, 200, cache);
}

/** The list is read-only: every other method answers 405. */
export async function action(): Promise<Response> {
  return json({ error: 'method_not_allowed', message: 'The gallery is read-only: use GET.' }, 405, { Allow: 'GET, HEAD' });
}
