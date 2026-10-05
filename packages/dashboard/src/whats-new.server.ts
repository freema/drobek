/**
 * The server half of the "What's new" notice (see ./whats-new.ts).
 *
 * The dismissed line lives in a cookie (`drobek_whats_new`, `__Host-` +
 * Secure in production, HttpOnly, SameSite=Lax, Path=/, 400 days), not in the
 * database: dismissing on one browser leaves the notice on another. Only a
 * signed-in person sees it, and every account does, including one created
 * after the current line was deployed (one click hides it).
 * `WHATS_NEW_BANNER=0` turns the notice off; `/whats-new` keeps redirecting.
 */
import { redirect } from 'react-router';
import { getSessionUser, hostCookieHeader, readCookieValue, cookieName, safeReturnPath } from '@drobek/auth';
import { releaseLineOf, formatLine, whatsNewLine, whatsNewTarget } from './whats-new.js';

export const WHATS_NEW_COOKIE = 'drobek_whats_new';
export const WHATS_NEW_MAX_AGE_SEC = 400 * 24 * 60 * 60;

/** `WHATS_NEW_BANNER`: on unless `0` / `off` / `false` / `no`. */
export function whatsNewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.WHATS_NEW_BANNER ?? '').trim().toLowerCase();
  return !['0', 'off', 'false', 'no'].includes(v);
}

export interface WhatsNewBanner {
  /** The release line the notice announces (`0.8`). */
  line: string;
}

/**
 * The notice for this request, or null. The session is looked up only when
 * the version and the cookie would show it; a session store failure hides it.
 */
export async function loadWhatsNewBanner(
  request: Request,
  deps: { env?: NodeJS.ProcessEnv; signedIn?: (request: Request) => Promise<boolean> } = {}
): Promise<WhatsNewBanner | null> {
  const env = deps.env ?? process.env;
  const line = whatsNewLine({
    version: env.DROBEK_VERSION,
    dismissed: readCookieValue(request.headers.get('cookie'), cookieName(WHATS_NEW_COOKIE, env)),
    enabled: whatsNewEnabled(env),
  });
  if (!line) return null;
  const signedIn = deps.signedIn ?? (async (r: Request) => (await getSessionUser(r)) !== null);
  try {
    return (await signedIn(request)) ? { line } : null;
  } catch {
    return null;
  }
}

/** GET /whats-new → 302 to the release notes of the running version. */
export function whatsNewRedirect(env: NodeJS.ProcessEnv = process.env): Response {
  return redirect(whatsNewTarget(env.DROBEK_VERSION), { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * POST /whats-new/dismiss — remembers the current line in the cookie and
 * sends the browser back to `redirectTo` (a same-origin path; `/` otherwise).
 * A build without a release line sets no cookie.
 */
export async function dismissWhatsNew(request: Request, env: NodeJS.ProcessEnv = process.env): Promise<Response> {
  let back = '/';
  try {
    const form = await request.formData();
    const to = form.get('redirectTo');
    back = safeReturnPath(typeof to === 'string' ? to : null) ?? '/';
  } catch {
    back = '/';
  }
  const current = releaseLineOf(env.DROBEK_VERSION);
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  if (current) {
    headers.append(
      'Set-Cookie',
      hostCookieHeader(WHATS_NEW_COOKIE, formatLine(current), { maxAgeSec: WHATS_NEW_MAX_AGE_SEC }, env)
    );
  }
  return redirect(back, { headers });
}
