/**
 * App slugs are GLOBALLY unique host labels: the app lives at
 * `<slug>.<APPS_DOMAIN>`, its working copy at `<slug>--preview.<APPS_DOMAIN>`.
 * The grammar forbids `--`, so a slug can never collide with those suffixes.
 * The same grammar is a CHECK constraint on `apps.slug` (@drobek/db).
 */
import { randomBytes } from 'node:crypto';

export const APP_SLUG_MIN = 3;
export const APP_SLUG_MAX = 40;
export const APP_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Host labels drobek keeps for itself (dashboard, API, mail, …). */
export const RESERVED_APP_SLUGS: ReadonlySet<string> = new Set([
  'www',
  'api',
  'mcp',
  'preview',
  'admin',
  'mail',
  'static',
  'app',
  'auth',
  'oauth',
]);

/** null when valid, else a human-readable reason. */
export function validateAppSlug(slug: string): string | null {
  if (slug.length < APP_SLUG_MIN || slug.length > APP_SLUG_MAX) {
    return `must be ${APP_SLUG_MIN}–${APP_SLUG_MAX} characters`;
  }
  if (!APP_SLUG_RE.test(slug)) {
    return 'may only contain a–z, 0–9 and single dashes between them';
  }
  if (RESERVED_APP_SLUGS.has(slug)) return `"${slug}" is reserved`;
  return null;
}

/**
 * Sanitize an arbitrary app name into slug grammar (lowercase, dash runs
 * collapsed, edges trimmed, truncated). Short or reserved results are not
 * fixed here — `validateAppSlug` reports them.
 */
export function deriveSlug(input: string): string {
  let base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length > APP_SLUG_MAX) base = base.slice(0, APP_SLUG_MAX).replace(/-+$/, '');
  return base;
}

/** `<slug>-<4hex>` within the length limit — the offer on a `slug_taken`. */
export function suggestSlug(slug: string, hex = randomBytes(2).toString('hex')): string {
  const room = APP_SLUG_MAX - 5;
  const base = deriveSlug(slug).slice(0, room).replace(/-+$/, '') || 'app';
  return `${base}-${hex}`;
}
