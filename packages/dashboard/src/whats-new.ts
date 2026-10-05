/**
 * The dashboard's "What's new" notice. A release line is the `major.minor`
 * of the running `DROBEK_VERSION` (`v0.8.3` → `0.8`); a signed-in person
 * sees the notice until they dismiss that line, and a later line shows it
 * again. A `dev` build or any version that is not `[v]X.Y.Z[-…]` has no line
 * and no notice. Pure and client-safe; the server half is
 * ./whats-new.server.ts.
 */
import { SOURCE_REPO_URL } from './source-link.js';

const VERSION_RE = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.+-]*)?$/;

export interface ReleaseLine {
  major: number;
  minor: number;
}

/** The release line of a version (`v0.8.3` → `{ major: 0, minor: 8 }`); null for `dev` or anything unparsable. */
export function releaseLineOf(version: string | null | undefined): ReleaseLine | null {
  const m = VERSION_RE.exec((version ?? '').trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/** A dismissal cookie value (`0.8`) → its line; null when it is not one. */
export function parseLine(value: string | null | undefined): ReleaseLine | null {
  const m = /^(\d{1,6})\.(\d{1,6})$/.exec((value ?? '').trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

export function formatLine(line: ReleaseLine): string {
  return `${line.major}.${line.minor}`;
}

/** Negative when `a` is older than `b`, 0 when equal, positive when newer. */
export function compareLines(a: ReleaseLine, b: ReleaseLine): number {
  return a.major !== b.major ? a.major - b.major : a.minor - b.minor;
}

/**
 * The line the notice announces, or null when there is none to show: the
 * notice is off, the build has no line, or the dismissed line is the current
 * one or newer.
 */
export function whatsNewLine(input: {
  version: string | null | undefined;
  dismissed: string | null | undefined;
  enabled: boolean;
}): string | null {
  if (!input.enabled) return null;
  const current = releaseLineOf(input.version);
  if (!current) return null;
  const dismissed = parseLine(input.dismissed);
  if (dismissed && compareLines(dismissed, current) >= 0) return null;
  return formatLine(current);
}

/**
 * Where `/whats-new` sends a visitor: the GitHub release of the exact running
 * tag, or the releases list for a build without a release version.
 */
export function whatsNewTarget(version: string | null | undefined): string {
  const raw = (version ?? '').trim();
  if (!releaseLineOf(raw)) return `${SOURCE_REPO_URL}/releases`;
  const tag = raw.startsWith('v') ? raw : `v${raw}`;
  return `${SOURCE_REPO_URL}/releases/tag/${encodeURIComponent(tag)}`;
}
