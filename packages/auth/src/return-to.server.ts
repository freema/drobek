/**
 * Post-login return target (U5, PHY-71). The /login loader stores a validated
 * same-origin path in the LOGIN_RETURN_COOKIE; the email-code verify action and
 * the Google callback consume it (clearing it) to redirect back instead of to
 * /me. Only same-origin *relative* paths are ever honored — never an absolute
 * URL, protocol-relative `//host`, or backslash trick — so this can't become an
 * open redirect.
 */
import {
  LOGIN_RETURN_COOKIE,
  LOGIN_RETURN_MAX_AGE_SEC,
} from './constants.js';

/** ASCII control chars (incl. CR/LF header-splitting) + DEL. */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

/** Accept only a same-origin path: leading `/`, not `//` or `/\`, no controls. */
export function safeReturnPath(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length > 2000) return null;
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  if (hasControlChar(value)) return null;
  return value;
}

function cookieAttrs(clear: boolean): string {
  const secure = process.env.NODE_ENV === 'production';
  return [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
    clear ? 'Max-Age=0' : `Max-Age=${LOGIN_RETURN_MAX_AGE_SEC}`,
  ]
    .filter(Boolean)
    .join('; ');
}

/** Set-Cookie value storing a (validated) return path, URL-encoded. */
export function loginReturnCookieHeader(path: string): string {
  return `${LOGIN_RETURN_COOKIE}=${encodeURIComponent(path)}; ${cookieAttrs(false)}`;
}

/** Set-Cookie value clearing the return cookie. */
export function clearLoginReturnCookieHeader(): string {
  return `${LOGIN_RETURN_COOKIE}=; ${cookieAttrs(true)}`;
}

/** Read + validate the return path from the request's cookies. */
export function readLoginReturnCookie(request: Request): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== LOGIN_RETURN_COOKIE) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return null;
    }
    return safeReturnPath(decoded);
  }
  return null;
}
