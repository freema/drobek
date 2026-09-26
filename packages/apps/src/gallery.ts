/**
 * The public gallery, the pure half (NSO-340): the on/off switch
 * (GALLERY_ENABLED), the public description rules, the page size and the
 * opaque cursor of `GET /api/public/gallery`. The stateful half (listing,
 * the super-admin hide, the public query) is gallery.server.ts.
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
