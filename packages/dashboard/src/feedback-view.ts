/**
 * The Feedback tab's pure view helpers (client-safe): which empty state a
 * list shows, where a note's "Open the preview" link goes, how a spot
 * reads, and how large the note page draws a screenshot before sending it.
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

/** "x 120, y 640 in a 1280×800 window — main > h1" */
export function anchorText(anchor: FeedbackAnchor | null): string {
  if (!anchor) return 'the whole page';
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

/** `width`×`height` scaled down (never up) so the longer side is at most `maxSide`, in whole pixels of at least 1. */
export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
