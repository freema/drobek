/**
 * Abuse and moderation vocabulary (M4-02, NSO-293). Pure — no I/O — so the
 * dashboard form, the queue, @drobek/serving's 451 page and the MCP refusal
 * all speak the same categories.
 *
 * A takedown stores ONE reason category in `apps.locked_reason`; that
 * category is the only thing the app's owner, its agent (`app_locked_by_admin`)
 * and its visitors (451 page) ever learn about it — never a reporter's text.
 */
import { dashboardOrigin } from './origin.js';

/** Why a super-admin takes an app down (`apps.locked_reason`). */
export const LOCK_REASONS = ['phishing', 'malware', 'spam', 'copyright', 'illegal', 'other'] as const;
export type LockReason = (typeof LOCK_REASONS)[number];

/** Why a report was filed: a reporter picks a lock reason; the publish heuristic files `heuristic`. */
export const REPORT_REASONS = [...LOCK_REASONS, 'heuristic'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

const LABELS: Record<ReportReason, string> = {
  phishing: 'Phishing or credential theft',
  malware: 'Malware or a malicious download',
  spam: 'Spam or scam',
  copyright: 'Copyright or trademark infringement',
  illegal: 'Illegal content',
  other: 'Other violation of the terms',
  heuristic: 'Flagged by the publish check',
};

export function isLockReason(value: unknown): value is LockReason {
  return typeof value === 'string' && (LOCK_REASONS as readonly string[]).includes(value);
}

export function isReportReason(value: unknown): value is ReportReason {
  return typeof value === 'string' && (REPORT_REASONS as readonly string[]).includes(value);
}

/** A human label for a reason category (an unknown value → the `other` label). */
export function reasonLabel(reason: string | null | undefined): string {
  return isReportReason(reason) ? LABELS[reason] : LABELS.other;
}

/** The category a stored `locked_reason` stands for (defensive: anything unknown is `other`). */
export function lockCategory(lockedReason: string | null | undefined): LockReason {
  return isLockReason(lockedReason) ? lockedReason : 'other';
}

/** The one sentence an agent / a dashboard user gets for a locked app. */
export function lockedMessage(lockedReason: string | null | undefined): string {
  const category = lockCategory(lockedReason);
  return `This app was taken down by the server operator (reason: ${category} — ${reasonLabel(category).toLowerCase()}). It cannot be changed, published or reconfigured until an operator restores it.`;
}

/** Max characters of a report's free-text details. */
export const REPORT_DETAILS_MAX = 2000;

/** The path of the well-known report pointer on every app host. */
export const REPORT_WELL_KNOWN_PATH = '/.well-known/drobek-report';

/** The public report form on the dashboard origin. */
export const REPORT_FORM_PATH = '/report';

/** The super-admin moderation queue on the dashboard origin. */
export const ABUSE_QUEUE_PATH = '/admin/abuse';

/** `<dashboard>/report?host=<host>` — where a visitor reports an app host. */
export function reportFormUrl(host: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${dashboardOrigin(env)}${REPORT_FORM_PATH}?host=${encodeURIComponent(host)}`;
}

/**
 * The terms the 451 page links to: `TERMS_URL`, else `<dashboard>/terms`
 * (drobek-web serves its ToS there; a self-hoster without one sets TERMS_URL).
 */
export function termsUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.TERMS_URL?.trim();
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === 'https:' || u.protocol === 'http:') return u.toString();
    } catch {
      // fall through to the default
    }
  }
  return `${dashboardOrigin(env)}/terms`;
}

/**
 * Normalize what a reporter typed as the host: a bare host, a host:port, or a
 * whole URL → lower-case `host[:port]` without a trailing dot. null when it is
 * not a plausible host at all.
 */
export function normalizeReportHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (value.length === 0 || value.length > 300) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      value = new URL(value).host;
    } catch {
      return null;
    }
  } else {
    value = value.split(/[/?#]/, 1)[0];
  }
  value = value.toLowerCase().replace(/\.+(?=:|$)/, '');
  if (!/^[a-z0-9.-]+(?::\d{1,5})?$/.test(value) || value.startsWith('.') || value.includes('..')) return null;
  return value;
}
