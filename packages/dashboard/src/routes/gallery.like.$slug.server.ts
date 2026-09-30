/**
 * GET/POST /gallery/like/:slug?back= — server half: a signed-in
 * drobek account likes (or unlikes) a gallery app. `GET /api/public/gallery`
 * hands the page out as each entry's `likeUrl`.
 *
 * Signed out → /login?returnTo= back to this page. The page shows the app and
 * its like count; the POST (a same-origin form, so the dashboard's origin
 * check covers it) sets the like — one per account and app — at most
 * GALLERY_LIKES_PER_USER_HOUR changes per account per hour (default 30 →
 * 429). `back` = where to return after the POST: honored only when its
 * origin is one of GALLERY_FRAME_ANCESTORS (the operator's gallery website),
 * so the page is no open redirect. An app the gallery does not show (or
 * GALLERY_ENABLED off) → 404.
 */
import { data, redirect, type ActionFunctionArgs, type HeadersArgs, type LoaderFunctionArgs } from 'react-router';
import { galleryEnabled, galleryEntryBySlug, galleryLikeState, setGalleryLike, type GalleryEntry } from '@drobek/apps';
import { getSessionUser, rateLimitRedis } from '@drobek/auth';
import { galleryFrameAncestorsFromEnv } from '@drobek/serving';

export const GALLERY_LIKES_RATE_BUCKET = 'gallery-like-user';
const HOUR_MS = 60 * 60 * 1000;

/** Like changes per account per hour. */
export function galleryLikesPerUserHour(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.GALLERY_LIKES_PER_USER_HOUR);
  return Number.isInteger(n) && n > 0 ? n : 30;
}

/** `back` when its origin is a GALLERY_FRAME_ANCESTORS origin, else null. */
export function safeGalleryBack(raw: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!raw || raw.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return galleryFrameAncestorsFromEnv(env).includes(url.origin) ? url.href : null;
}

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };

export function headers({ actionHeaders, loaderHeaders }: HeadersArgs) {
  return actionHeaders.has('Retry-After') ? actionHeaders : loaderHeaders;
}

async function entryOr404(slug: string | undefined): Promise<GalleryEntry> {
  const entry = galleryEnabled() ? await galleryEntryBySlug(String(slug ?? '')) : null;
  if (!entry) throw data({ error: 'This app is not in the gallery.' }, { status: 404, headers: NO_STORE });
  return entry;
}

function loginRedirect(request: Request): Response {
  const url = new URL(request.url);
  return redirect(`/login?returnTo=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const entry = await entryOr404(params.slug);
  const user = await getSessionUser(request);
  if (!user) throw loginRedirect(request);
  const state = await galleryLikeState(entry.id, user.id);
  const back = safeGalleryBack(new URL(request.url).searchParams.get('back'));
  return data(
    { name: entry.name, description: entry.description, url: entry.url, email: user.email, back, ...state },
    { headers: NO_STORE }
  );
}

type ActionResult = { ok: true; likes: number; liked: boolean } | { ok: false; error: string };

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== 'POST') {
    return data<ActionResult>({ ok: false, error: 'Use the button.' }, { status: 405 });
  }
  const entry = await entryOr404(params.slug);
  const user = await getSessionUser(request);
  if (!user) throw loginRedirect(request);
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  if (intent !== 'like' && intent !== 'unlike') {
    return data<ActionResult>({ ok: false, error: 'Use the button.' }, { status: 400 });
  }
  const limit = await rateLimitRedis(GALLERY_LIKES_RATE_BUCKET, user.id, galleryLikesPerUserHour(), HOUR_MS);
  if (!limit.ok) {
    return data<ActionResult>(
      { ok: false, error: 'You changed likes too often in the last hour. Try again later.' },
      { status: 429, headers: { 'Retry-After': '3600' } }
    );
  }
  const state = await setGalleryLike(entry.id, user.id, intent === 'like');
  const back = safeGalleryBack(String(form.get('back') ?? '') || null);
  if (back) throw redirect(back);
  return data<ActionResult>({ ok: true, ...state });
}
