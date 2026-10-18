/**
 * The few pages an app host renders itself: not found, not published,
 * the password form, an error and the 451 "taken down" page. All of them go
 * through `platformPageShell` — the platform look shared with the public
 * dashboard pages and the e-mails (@drobek/core/platform-theme), light or
 * dark after the visitor's system setting. Plain HTML with one inline
 * <style> (allowed by the app CSP's style-src 'unsafe-inline'), the mascot as
 * inline SVG (no request), no script, and the form posts to the same host
 * (form-action 'self'). Every value is HTML-escaped.
 */
import { platformPageCss } from '@drobek/core/platform-theme';
import { mascotSvg } from '@drobek/email/mascot';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = platformPageCss();
const MARK = mascotSvg().replace('<svg ', '<svg width="32" height="22" aria-hidden="true" ');

export interface PlatformPageShellInput {
  /** The `data-drobek-page` marker: which page this is (`missing`, `password`, `error`, `locked`). */
  page: string;
  /** The document title (plain text). */
  title: string;
  /** The page's heading (plain text). */
  heading: string;
  /** HTML under the heading — the caller escapes every value in it. */
  body: string;
  /** HTML of the small print under a rule; none when omitted. */
  footer?: string;
}

/** A whole app-host platform page: the mascot and wordmark, the heading, the body, the optional foot. */
export function platformPageShell({ page, title, heading, body, footer }: PlatformPageShellInput): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style></head>
<body><main class="drobek-page" data-drobek-page="${escapeHtml(page)}">
<div class="drobek-mark">${MARK}<span>drobek</span></div>
<h1>${escapeHtml(heading)}</h1>
${body}${footer ? `\n<p class="drobek-foot">${footer}</p>` : ''}
</main></body></html>
`;
}

export type MissingReason = 'no-app' | 'not-published' | 'nothing-compiled' | 'no-version' | 'no-file';

const MISSING: Record<MissingReason, { title: string; text: string; next: string }> = {
  'no-app': {
    title: 'Not found',
    text: 'There is no app at this address.',
    next: 'Check the address for typos, or ask whoever sent you the link for the right one.',
  },
  'not-published': {
    title: 'Not published yet',
    text: 'This app exists but has not been published yet.',
    next: 'Come back once its owner publishes it.',
  },
  'nothing-compiled': {
    title: 'Nothing to preview yet',
    text: 'No version of this app has compiled yet.',
    next: 'The preview appears here as soon as a version compiles.',
  },
  'no-version': {
    title: 'Not found',
    text: 'This version does not exist or did not compile.',
    next: 'Open the app’s preview for its latest version instead.',
  },
  'no-file': {
    title: 'Not found',
    text: 'This page does not exist in the app.',
    next: 'Check the address, or go to the app’s start page.',
  },
};

export function missingPage(reason: MissingReason): string {
  const m = MISSING[reason];
  const home = reason === 'no-file' ? `\n<p><a href="/">Go to the start page</a></p>` : '';
  return platformPageShell({
    page: 'missing',
    title: m.title,
    heading: m.title,
    body: `<p>${escapeHtml(m.text)}</p>\n<p class="drobek-hint">${escapeHtml(m.next)}</p>${home}`,
  });
}

export const UNLOCK_PATH = '/__drobek/password';

export function passwordPage(opts: { next: string; error?: 'wrong' | 'rate_limited' | null }): string {
  const error =
    opts.error === 'wrong'
      ? '<p class="drobek-error" role="alert">Incorrect password. Try again.</p>'
      : opts.error === 'rate_limited'
        ? '<p class="drobek-error" role="alert">Too many attempts. Wait a few minutes and try again.</p>'
        : '';
  return platformPageShell({
    page: 'password',
    title: 'Password required',
    heading: 'This app is password protected',
    body: `<p class="drobek-hint">Enter the password to continue. If you do not have it, ask whoever shared the app with you.</p>
${error}<form method="POST" action="${UNLOCK_PATH}">
  <input type="hidden" name="next" value="${escapeHtml(opts.next)}">
  <label class="drobek-label" for="drobek-app-password">Password</label>
  <input class="drobek-input" id="drobek-app-password" name="password" type="password" autocomplete="current-password" autofocus required>
  <button class="drobek-button drobek-button-block" type="submit">Unlock</button>
</form>`,
  });
}

export function errorPage(title: string, text: string): string {
  return platformPageShell({ page: 'error', title, heading: title, body: `<p>${escapeHtml(text)}</p>` });
}

/**
 * 451 Unavailable For Legal Reasons (RFC 7725) — a super-admin took the app
 * down. Names the reason category only, links the operator's terms.
 */
export function lockedPage(opts: { reasonLabel: string; termsUrl: string }): string {
  return platformPageShell({
    page: 'locked',
    title: 'Unavailable',
    heading: 'This app is unavailable',
    body: `<p>It was taken down by the operator of this server for a violation of the terms of service (${escapeHtml(opts.reasonLabel.toLowerCase())}).</p>
<p class="drobek-hint">Only the operator can bring it back. The terms explain the rules and how to reach them.</p>`,
    footer: `<a href="${escapeHtml(opts.termsUrl)}" rel="noopener noreferrer">Terms of service</a>`,
  });
}
