/**
 * The Feedback tab's pure view helpers (client-safe): which empty state a
 * list shows, where a note's "Open the preview" link goes, and how a spot
 * reads.
 */
import type { FeedbackAnchor } from '@drobek/apps';

export type FeedbackFilter = 'open' | 'resolved' | 'all';

/**
 * What the list shows: the notes, or which empty state — `none` (the app has
 * no notes at all), `all-resolved` (no open notes, some resolved),
 * `none-resolved` (the resolved filter finds nothing), `error` (the page
 * could not be read).
 */
export function feedbackListState(input: {
  filter: FeedbackFilter;
  rows: number;
  open: number;
  resolved: number;
  error: string | null;
}): 'error' | 'rows' | 'none' | 'all-resolved' | 'none-resolved' {
  if (input.error) return 'error';
  if (input.rows > 0) return 'rows';
  if (input.open + input.resolved === 0) return 'none';
  if (input.filter === 'open') return 'all-resolved';
  return 'none-resolved';
}

/**
 * A spot in parts: the element's label (`button "Send"`) when the widget
 * named it, where on the page (`x 412, y 230 · 1280×720`) and the CSS
 * selector when known. Null for a note on the whole page.
 */
export function feedbackSpot(anchor: FeedbackAnchor | null): { label: string | null; where: string; selector: string | null } | null {
  if (!anchor) return null;
  return { label: anchor.label ?? null, where: `x ${anchor.x}, y ${anchor.y} · ${anchor.vw}×${anchor.vh}`, selector: anchor.selector ?? null };
}

/**
 * The spot as one line: `button "Send" · x 412, y 230 · 1280×720` with a
 * label, else `x 120, y 640 in a 1280×800 window — main > h1`.
 */
export function anchorText(anchor: FeedbackAnchor | null): string {
  if (!anchor) return 'the whole page';
  if (anchor.label) return `${anchor.label} · x ${anchor.x}, y ${anchor.y} · ${anchor.vw}×${anchor.vh}`;
  const where = `x ${anchor.x}, y ${anchor.y} in a ${anchor.vw}×${anchor.vh} window`;
  return anchor.selector ? `${where} — ${anchor.selector}` : where;
}

/**
 * The page a note was left on, on the host of its version (`<slug>--v<N>`),
 * or on the preview when the version is unknown.
 */
export function noteOpenUrl(note: { versionNumber: number | null; path: string }, hosts: { preview: string; version: (n: number) => string }): string {
  const origin = note.versionNumber !== null ? hosts.version(note.versionNumber) : hosts.preview;
  return `${origin}${note.path.startsWith('/') ? note.path : '/'}`;
}
