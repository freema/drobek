/**
 * Feedback on the app preview — the pure half: the limits, what a note's
 * context may hold and how it is cleaned. Client-safe (no database).
 *
 * A note is written by a signed-in member of the app's workspace on the
 * dashboard page the preview's widget opens; everything the widget passes
 * along in that page's URL (path, version, spot, selector) comes from an
 * untrusted origin (the app host runs app code), so each value is bounded and
 * cleaned here, and the body is never taken from the URL.
 */

/** Characters of a note's body. */
export const FEEDBACK_BODY_MAX = 4000;
/** Characters of the note an editor or agent leaves when resolving. */
export const FEEDBACK_RESOLUTION_NOTE_MAX = 1000;
/** Characters of the page path a note is pinned to. */
export const FEEDBACK_PATH_MAX = 1000;
/** Characters of the CSS selector of the spot a note is pinned to. */
export const FEEDBACK_SELECTOR_MAX = 500;
/** Notes one page of the list holds at most (the dashboard's page and list_feedback's largest `limit`). */
export const FEEDBACK_PAGE_MAX = 100;

export const DEFAULT_FEEDBACK_MAX_OPEN_PER_APP = 500;
export const DEFAULT_FEEDBACK_PER_USER_HOUR = 30;

export const FEEDBACK_STATUSES = ['open', 'resolved'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export interface FeedbackLimits {
  /** FEEDBACK_MAX_OPEN_PER_APP: open notes an app may hold; a new note past it is refused. */
  maxOpenPerApp: number;
  /** FEEDBACK_PER_USER_HOUR: notes one account may leave within an hour, over all apps. */
  perUserHour: number;
}

function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isInteger(n) && n > 0 ? n : fallback;
}

export function feedbackLimits(env: NodeJS.ProcessEnv = process.env): FeedbackLimits {
  return {
    maxOpenPerApp: positiveIntEnv(env.FEEDBACK_MAX_OPEN_PER_APP, DEFAULT_FEEDBACK_MAX_OPEN_PER_APP),
    perUserHour: positiveIntEnv(env.FEEDBACK_PER_USER_HOUR, DEFAULT_FEEDBACK_PER_USER_HOUR),
  };
}

/** Where on the page a note is pinned: document coordinates, the viewport the reviewer had, and the element when known. */
export interface FeedbackAnchor {
  selector?: string;
  x: number;
  y: number;
  vw: number;
  vh: number;
}

const COORD_MAX = 1_000_000;

function coord(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const v = Math.round(n);
  return v >= 0 && v <= COORD_MAX ? v : null;
}

/** Control characters out, whitespace runs collapsed, cut to `max` characters. */
function oneLine(raw: string, max: number): string {
  let out = '';
  for (const ch of raw) {
    const c = ch.codePointAt(0)!;
    out += c <= 0x1f || (c >= 0x7f && c <= 0x9f) ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * The spot of a note from the widget's values, or null when x / y / the
 * viewport are missing or out of range (a note on the whole page). The
 * selector is optional and kept as plain text: it is shown and handed to the
 * agent, never evaluated.
 */
export function parseFeedbackAnchor(input: { selector?: unknown; x?: unknown; y?: unknown; vw?: unknown; vh?: unknown }): FeedbackAnchor | null {
  const x = coord(input.x);
  const y = coord(input.y);
  const vw = coord(input.vw);
  const vh = coord(input.vh);
  if (x === null || y === null || vw === null || vh === null || vw === 0 || vh === 0) return null;
  const selector = typeof input.selector === 'string' ? oneLine(input.selector, FEEDBACK_SELECTOR_MAX) : '';
  return { ...(selector ? { selector } : {}), x, y, vw, vh };
}

/** A stored anchor read back (a jsonb value), or null when it is not one. */
export function storedFeedbackAnchor(raw: unknown): FeedbackAnchor | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return parseFeedbackAnchor(raw as Record<string, unknown>);
}

/**
 * The page path a note is pinned to: an absolute path without the query and
 * fragment, control characters removed, at most FEEDBACK_PATH_MAX characters.
 * Anything that is not a path (a URL, `//host`, empty) becomes `/`.
 */
export function normalizeFeedbackPath(raw: unknown): string {
  if (typeof raw !== 'string') return '/';
  const path = raw.split(/[?#]/, 1)[0] ?? '';
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return '/';
  let out = '';
  for (const ch of path) {
    const c = ch.codePointAt(0)!;
    if (c > 0x1f && c !== 0x7f) out += ch;
  }
  return out.slice(0, FEEDBACK_PATH_MAX) || '/';
}

/** The version a note was left on, or null when the value is not a version number. */
export function feedbackVersionNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** A note's body: trimmed, 1..FEEDBACK_BODY_MAX characters (line breaks kept, other control characters dropped). */
export function validateFeedbackBody(raw: unknown): { ok: true; body: string } | { ok: false; message: string } {
  if (typeof raw !== 'string') return { ok: false, message: 'Write what you noticed before sending.' };
  let body = '';
  for (const ch of raw.replace(/\r\n?/g, '\n')) {
    const c = ch.codePointAt(0)!;
    if (ch === '\n' || ch === '\t' || (c > 0x1f && c !== 0x7f)) body += ch;
  }
  body = body.trim();
  if (!body) return { ok: false, message: 'Write what you noticed before sending.' };
  if (body.length > FEEDBACK_BODY_MAX) {
    return { ok: false, message: `A note can be at most ${FEEDBACK_BODY_MAX} characters; this one has ${body.length}.` };
  }
  return { ok: true, body };
}

/** The note left when resolving: trimmed, at most FEEDBACK_RESOLUTION_NOTE_MAX characters; empty = none. */
export function validateResolutionNote(raw: unknown): { ok: true; note: string | null } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, note: null };
  if (typeof raw !== 'string') return { ok: false, message: 'The resolution note must be text.' };
  const note = raw.trim();
  if (note.length > FEEDBACK_RESOLUTION_NOTE_MAX) {
    return { ok: false, message: `The resolution note can be at most ${FEEDBACK_RESOLUTION_NOTE_MAX} characters; this one has ${note.length}.` };
  }
  return { ok: true, note: note || null };
}

const FEEDBACK_ID_RE = /^fb_[0-9a-f]{24}$/;

export function isFeedbackId(raw: unknown): raw is string {
  return typeof raw === 'string' && FEEDBACK_ID_RE.test(raw);
}

/** `open`, `resolved` or `all` from a filter value; anything else is the default `open`. */
export function parseFeedbackFilter(raw: unknown): FeedbackStatus | 'all' {
  return raw === 'resolved' || raw === 'all' ? raw : 'open';
}

/** Who may delete a note: its author, and a workspace admin (super-admins act as one). */
export function mayDeleteFeedback(note: { authorUserId: string | null }, actor: { userId: string; role: string }): boolean {
  return actor.role === 'workspace-admin' || (note.authorUserId !== null && note.authorUserId === actor.userId);
}
