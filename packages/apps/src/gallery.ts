/**
 * The public gallery, the pure half (NSO-340): the on/off switch
 * (GALLERY_ENABLED), the public description rules, the page size, the
 * search / sort / page parameters and the opaque cursor of
 * `GET /api/public/gallery`. The stateful half (listing, the super-admin
 * hide, the public query) is gallery.server.ts.
 */

/** The public description: plain text, one or two sentences. */
export const GALLERY_DESCRIPTION_MAX = 160;
/** Entries per page of the public list by default, and at most (`?limit`). */
export const GALLERY_PAGE_SIZE = 24;
export const GALLERY_PAGE_MAX = 48;

/**
 * Whether this server runs the public gallery. Off unless GALLERY_ENABLED is
 * `1` / `true` / `yes` / `on`: a self-hosted server publishes no app list
 * until its operator decides to.
 */
export function galleryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.GALLERY_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// Control characters, including line breaks, tabs and U+2028/9 (written as escapes on purpose).
const CONTROL_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+', 'g');

export type GalleryDescriptionResult = { ok: true; value: string } | { ok: false; message: string };

/**
 * Normalize an owner's (or agent's) gallery description: control characters
 * and line breaks become spaces, runs of whitespace collapse, the ends are
 * trimmed. Empty or longer than GALLERY_DESCRIPTION_MAX characters is refused.
 * The result is plain text; every renderer escapes it.
 */
export function normalizeGalleryDescription(raw: unknown): GalleryDescriptionResult {
  const text = typeof raw === 'string' ? raw.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim() : '';
  if (!text) {
    return { ok: false, message: 'Write a short public description (one or two sentences) for the gallery.' };
  }
  const length = [...text].length;
  if (length > GALLERY_DESCRIPTION_MAX) {
    return {
      ok: false,
      message: `The gallery description can be at most ${GALLERY_DESCRIPTION_MAX} characters (it has ${length}).`,
    };
  }
  return { ok: true, value: text };
}

/** `?limit` → the page size: GALLERY_PAGE_SIZE by default, clamped to 1..GALLERY_PAGE_MAX. */
export function galleryPageSize(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.trim() === '') return GALLERY_PAGE_SIZE;
  const n = Number(raw);
  if (!Number.isFinite(n)) return GALLERY_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(n), 1), GALLERY_PAGE_MAX);
}

/** The longest `?q` search text (characters; longer input is cut). */
export const GALLERY_QUERY_MAX = 100;
/** The highest `?page` number taken as given (a larger one is clamped to it). */
export const GALLERY_PAGE_NUMBER_MAX = 100_000;

/** `?q` → the search text: trimmed, at most GALLERY_QUERY_MAX characters; null when empty. */
export function galleryQuery(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  return [...text].slice(0, GALLERY_QUERY_MAX).join('').trim() || null;
}

/**
 * Strip combining accents (matching the SQL normalization) and build an
 * ILIKE pattern `%<text>%` with the LIKE wildcards
 * `%`, `_` and the escape character `\` escaped, so every character of the
 * text matches itself (used with `ESCAPE '\'`).
 */
export function galleryLikePattern(text: string): string {
  return `%${text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\\%_]/g, '\\$&')}%`;
}

/**
 * The public list's order: `new` = newest publish first (the default),
 * `name` = name A→Z, `popular` = the highest GALLERY_POPULAR_LIKE_WEIGHT ×
 * likes + opens in the last GALLERY_OPENS_WINDOW_DAYS first.
 */
export type GallerySort = 'new' | 'name' | 'popular';

/** `?sort` → `name`, `popular` or (anything else) `new`. */
export function gallerySort(raw: string | null | undefined): GallerySort {
  const v = raw?.trim().toLowerCase();
  return v === 'name' || v === 'popular' ? v : 'new';
}

/** The window `opens` counts: the last 30 UTC days, today included. */
export const GALLERY_OPENS_WINDOW_DAYS = 30;
/** `popular` weighs one like as this many opens. */
export const GALLERY_POPULAR_LIKE_WEIGHT = 5;

/** A UTC day as `YYYY-MM-DD` (the `gallery_opens.day` key). */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The first UTC day inside the `opens` window that ends on `now`. */
export function galleryOpensSince(now: Date): string {
  return utcDay(new Date(now.getTime() - (GALLERY_OPENS_WINDOW_DAYS - 1) * 86_400_000));
}

/**
 * Whether a request is a browser prefetch or preview rather than a person
 * opening the app (`Sec-Purpose` / `Purpose: prefetch`, Firefox `X-Moz`,
 * Safari `X-Purpose: preview`); such a request is redirected but not counted.
 */
export function isPrefetchRequest(headers: Headers): boolean {
  const purpose = [headers.get('sec-purpose'), headers.get('purpose'), headers.get('x-moz'), headers.get('x-purpose')]
    .filter((v): v is string => v !== null)
    .join(' ')
    .toLowerCase();
  return /\b(prefetch|prerender|preview)\b/.test(purpose);
}

/**
 * `?page` → a 1-based page number, or null when the parameter is absent or
 * empty. Anything that is not a whole number ≥ 1 is page 1; a huge number is
 * clamped to GALLERY_PAGE_NUMBER_MAX.
 */
export function galleryPageNumber(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.trunc(n) < 1) return 1;
  return Math.min(Math.trunc(n), GALLERY_PAGE_NUMBER_MAX);
}

/** Where the next page starts: the last entry's publish time and slug (both public). */
export interface GalleryCursor {
  publishedAt: Date;
  slug: string;
}

const CURSOR_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The opaque `next` token: base64url of `<publishedAt ms>.<slug>`. No app id, no owner data. */
export function encodeGalleryCursor(c: GalleryCursor): string {
  return Buffer.from(`${c.publishedAt.getTime()}.${c.slug}`, 'utf8').toString('base64url');
}

/** The cursor back, or null for anything that is not one (a bad token = the first page). */
export function decodeGalleryCursor(token: string | null | undefined): GalleryCursor | null {
  if (!token || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const raw = Buffer.from(token, 'base64url').toString('utf8');
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  const ms = Number(raw.slice(0, dot));
  const slug = raw.slice(dot + 1);
  if (!Number.isSafeInteger(ms) || ms < 0 || !CURSOR_SLUG_RE.test(slug) || slug.length > 40) return null;
  return { publishedAt: new Date(ms), slug };
}

/**
 * Whether the public list shows this app right now — the row-level twin of
 * the public query's filter (gallery.server.ts visibleInGallery): listed AND
 * published AND public AND not taken down AND not deleted AND not hidden.
 * The app hosts use it to let the operator's gallery frame the production
 * host (GALLERY_FRAME_ANCESTORS).
 */
export function isGalleryVisible(app: {
  galleryListed: boolean;
  galleryDescription: string | null;
  galleryHiddenAt: Date | null;
  publishedVersionId: string | null;
  publishedAt: Date | null;
  lockedReason: string | null;
  visibility: string;
  deletedAt: Date | null;
}): boolean {
  return (
    app.galleryListed &&
    app.publishedVersionId !== null &&
    app.publishedAt !== null &&
    app.galleryDescription !== null &&
    app.visibility === 'public' &&
    app.lockedReason === null &&
    app.deletedAt === null &&
    app.galleryHiddenAt === null
  );
}

/** An app's gallery state as the dashboard and get_app show it. */
export interface GalleryState {
  /** The owner's opt-in. */
  listed: boolean;
  description: string | null;
  /** A super-admin hid the entry; listing is refused until they show it again. */
  hiddenByAdmin: boolean;
  /** Whether the public list shows the app right now. */
  visible: boolean;
}

/**
 * The effective state of one app. The public list shows it only when it is
 * listed AND published AND public (no password gate) AND not taken down AND
 * not hidden by a super-admin — the same filter the public query applies.
 */
export function galleryState(app: {
  galleryListed: boolean;
  galleryDescription: string | null;
  galleryHiddenAt: Date | null;
  publishedVersionId: string | null;
  lockedReason: string | null;
  visibility: string;
}): GalleryState {
  const hiddenByAdmin = app.galleryHiddenAt !== null;
  return {
    listed: app.galleryListed,
    description: app.galleryDescription,
    hiddenByAdmin,
    visible:
      app.galleryListed &&
      app.publishedVersionId !== null &&
      app.lockedReason === null &&
      !hiddenByAdmin &&
      app.visibility === 'public',
  };
}
