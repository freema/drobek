/**
 * App-slug derivation (U6, PHY-57): "slug from the app name, overridable".
 * Pure — the per-workspace uniqueness suffix is applied by the db layer via
 * `slugCandidate`. App slugs live in a per-workspace namespace (apps.slug is
 * UNIQUE per workspace), distinct from the global workspace-slug rules.
 */

export const APP_SLUG_MAX = 40;

/**
 * Sanitize an arbitrary name/slug into `[a-z0-9-]`, collapse dash runs, trim
 * edge dashes, truncate, and fall back to "app" when nothing usable remains.
 */
export function deriveSlug(input: string): string {
  let base = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length > APP_SLUG_MAX) {
    base = base.slice(0, APP_SLUG_MAX).replace(/-+$/, '');
  }
  return base.length > 0 ? base : 'app';
}

/** attempt 0 → base; attempt n → base-(n+1) (numeric suffix on collision). */
export function slugCandidate(base: string, attempt: number): string {
  return attempt === 0 ? base : `${base}-${attempt + 1}`;
}
