/**
 * Screenshots an agent asks for — the pure half: limits, ids, the note and
 * the upload path. Client-safe (no database, no Redis).
 *
 *   SCREENSHOT_REQUEST_TTL_SEC        how long a request waits for the person (600)
 *   SCREENSHOT_REQUESTS_PER_APP_HOUR  requests per app within an hour (20)
 *   SCREENSHOTS_RETENTION_DAYS        days a captured screenshot is kept (7)
 */

/** Characters of the note the agent shows with its request. */
export const SCREENSHOT_NOTE_MAX = 200;
/** Seconds get_screenshot asks the agent to wait between two looks at a pending request. */
export const SCREENSHOT_RETRY_AFTER_SECONDS = 10;
/** Screenshots one page of the Feedback tab's list holds. */
export const SCREENSHOT_LIST_MAX = 50;

export const DEFAULT_SCREENSHOT_REQUEST_TTL_SEC = 600;
export const DEFAULT_SCREENSHOT_REQUESTS_PER_APP_HOUR = 20;
export const DEFAULT_SCREENSHOTS_RETENTION_DAYS = 7;

/** Where the preview uploads a screenshot (or declines a request) on the dashboard origin: `/api/screenshots/<request_id>`. */
export const SCREENSHOT_UPLOAD_PATH_PREFIX = '/api/screenshots/';

export interface ScreenshotLimits {
  /** SCREENSHOT_REQUEST_TTL_SEC */
  requestTtlSec: number;
  /** SCREENSHOT_REQUESTS_PER_APP_HOUR */
  requestsPerAppHour: number;
  /** SCREENSHOTS_RETENTION_DAYS */
  retentionDays: number;
}

function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isInteger(n) && n > 0 ? n : fallback;
}

export function screenshotLimits(env: NodeJS.ProcessEnv = process.env): ScreenshotLimits {
  return {
    requestTtlSec: positiveIntEnv(env.SCREENSHOT_REQUEST_TTL_SEC, DEFAULT_SCREENSHOT_REQUEST_TTL_SEC),
    requestsPerAppHour: positiveIntEnv(env.SCREENSHOT_REQUESTS_PER_APP_HOUR, DEFAULT_SCREENSHOT_REQUESTS_PER_APP_HOUR),
    retentionDays: positiveIntEnv(env.SCREENSHOTS_RETENTION_DAYS, DEFAULT_SCREENSHOTS_RETENTION_DAYS),
  };
}

/** The most bytes an upload request may carry: the screenshot plus the token, the path and the multipart framing. */
export function screenshotUploadMaxBytes(screenshotMaxBytes: number): number {
  return screenshotMaxBytes + 64 * 1024;
}

/**
 * The agent's note: one line (line breaks become spaces, other control
 * characters are dropped), trimmed, at most SCREENSHOT_NOTE_MAX characters;
 * empty = none.
 */
export function validateScreenshotNote(raw: unknown): { ok: true; note: string | null } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, note: null };
  if (typeof raw !== 'string') return { ok: false, message: '`note` must be text.' };
  let note = '';
  for (const ch of raw) {
    const c = ch.codePointAt(0)!;
    if (ch === '\n' || ch === '\r' || ch === '\t') note += ' ';
    else if (c > 0x1f && c !== 0x7f) note += ch;
  }
  note = note.replace(/ {2,}/g, ' ').trim();
  if (note.length > SCREENSHOT_NOTE_MAX) {
    return { ok: false, message: `\`note\` can be at most ${SCREENSHOT_NOTE_MAX} characters; this one has ${note.length}.` };
  }
  return { ok: true, note: note || null };
}

const REQUEST_ID_RE = /^ss_[0-9a-f]{24}$/;

export function isScreenshotRequestId(raw: unknown): raw is string {
  return typeof raw === 'string' && REQUEST_ID_RE.test(raw);
}

/** The browser family the preview reports with a screenshot; anything else is `other`. */
export function screenshotBrowser(raw: unknown): string {
  return raw === 'chrome' || raw === 'edge' || raw === 'firefox' || raw === 'safari' ? raw : 'other';
}
