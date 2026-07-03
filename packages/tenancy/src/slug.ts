/**
 * Workspace slug rules (U4, PHY-54): [a-z0-9-], 3–40 chars, globally unique
 * (workspaces.slug UNIQUE enforces that), reserved list below. Pure functions
 * only — db-facing callers live in *-workspace.server.ts.
 */

export const SLUG_MIN = 3;
export const SLUG_MAX = 40;

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'api',
  'mcp',
  'admin',
  'app',
  'apps',
  'www',
  'assets',
  'static',
  'login',
  'me',
  'invite',
  'workspaces',
  'healthz',
  'private',
]);

const SLUG_RE = /^[a-z0-9-]+$/;

/** Returns a user-facing error message, or null when the slug is acceptable. */
export function validateTeamSlug(slug: string): string | null {
  if (slug.length < SLUG_MIN || slug.length > SLUG_MAX) {
    return `Slug must be ${SLUG_MIN}–${SLUG_MAX} characters.`;
  }
  if (!SLUG_RE.test(slug)) {
    return 'Slug may only contain lowercase letters, digits and dashes.';
  }
  if (RESERVED_SLUGS.has(slug)) {
    return 'That slug is reserved. Pick another one.';
  }
  return null;
}

/**
 * Personal-workspace slug base from the sanitized email local-part:
 * lowercase, non-[a-z0-9-] runs → single dash, edge dashes trimmed, truncated
 * to leave room for a collision suffix, padded to the minimum length, and
 * nudged off the reserved list ("admin@…" must not claim /workspaces/admin).
 */
export function personalSlugBase(email: string): string {
  const local = email.split('@')[0] ?? '';
  let base = local
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Leave room for "-NN" collision suffixes under SLUG_MAX.
  if (base.length > SLUG_MAX - 4) {
    base = base.slice(0, SLUG_MAX - 4).replace(/-+$/, '');
  }
  if (base.length === 0) base = 'workspace';
  else if (base.length < SLUG_MIN) base = `ws-${base}`;
  if (RESERVED_SLUGS.has(base)) base = `${base}-ws`;
  return base;
}

/** attempt 0 → base; attempt n → base-(n+1) (numeric suffix on collision). */
export function personalSlugCandidate(base: string, attempt: number): string {
  return attempt === 0 ? base : `${base}-${attempt + 1}`;
}
