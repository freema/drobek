/**
 * redirect_uri handling (U5, R6 security sleeper). OAuth 2.1 mandates an EXACT
 * string match between the authorize/token redirect_uri and a registered one —
 * no prefix, suffix, subdomain, or trailing-slash leniency (that is how open
 * redirectors and token exfiltration happen).
 */

/** EXACT string equality against the registered set. No normalization. */
export function exactRedirectUriMatch(
  candidate: string,
  registered: readonly string[]
): boolean {
  return registered.some((uri) => uri === candidate);
}

/**
 * DCR redirect_uri policy: absolute https, OR http on a loopback host
 * (localhost / 127.0.0.1 / [::1]) for native + dev clients. No fragments.
 */
export function isValidRegisterRedirectUri(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') {
    const host = url.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  }
  return false;
}

/** RFC 8707 resource: an absolute URI with no fragment. */
export function isValidResource(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return !url.hash && Boolean(url.protocol);
}
