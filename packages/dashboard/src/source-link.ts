/**
 * AGPL-3.0 §13 source offer (M2-04, NSO-284): every dashboard page links to
 * the exact source of the running build. The sha is the one baked into the
 * image (`GIT_SHA` build-arg, the same value `/api/version` reports); a dev
 * run without one ("dev", empty, or anything that is not a hex sha) links to
 * the default branch tree instead. Pure and client-safe.
 */

/** The public source repository of drobek core (AGPL-3.0). */
export const SOURCE_REPO_URL = 'https://github.com/freema/drobek';

/** Where a build without a commit sha points. */
const SOURCE_FALLBACK_BRANCH = 'main';

const SHA_RE = /^[0-9a-f]{7,40}$/;

export interface SourceLink {
  href: string;
  /** The short sha, or null for the branch fallback. */
  sha: string | null;
}

/** The footer link for a build sha (GIT_SHA). */
export function sourceLink(rawSha: string | null | undefined): SourceLink {
  const sha = (rawSha ?? '').trim().toLowerCase();
  if (SHA_RE.test(sha)) {
    const short = sha.slice(0, 7);
    return {
      href: `${SOURCE_REPO_URL}/commit/${sha}`,
      sha: short,
    };
  }
  return {
    href: `${SOURCE_REPO_URL}/tree/${SOURCE_FALLBACK_BRANCH}`,
    sha: null,
  };
}
