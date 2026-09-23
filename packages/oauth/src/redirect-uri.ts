/**
 * redirect_uri handling (U5, R6 security sleeper). OAuth 2.1 mandates an EXACT
 * string match between the authorize/token redirect_uri and a registered one —
 * no prefix, suffix, subdomain, or trailing-slash leniency (that is how open
 * redirectors and token exfiltration happen). The same registration policy
 * applies to DCR bodies and CIMD documents (M0-04).
 */
import {
  CLIENT_NAME_MAX_LENGTH,
  REDIRECT_URI_MAX_LENGTH,
  REDIRECT_URIS_MAX,
} from './constants.js';

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

export type ClientMetadataCheck =
  | { ok: true; clientName: string; redirectUris: string[] }
  | { ok: false; error: 'invalid_client_metadata' | 'invalid_redirect_uri'; description: string };

/**
 * Validate the client-supplied half of a public client's metadata — shared by
 * DCR (`/oauth/register`) and CIMD documents: a non-empty, capped client_name
 * and 1–REDIRECT_URIS_MAX redirect_uris that each pass the registration policy.
 */
export function checkClientMetadata(input: {
  clientName: unknown;
  redirectUris: unknown;
}): ClientMetadataCheck {
  const clientName = typeof input.clientName === 'string' ? input.clientName.trim() : '';
  if (!clientName) {
    return { ok: false, error: 'invalid_client_metadata', description: 'client_name is required' };
  }
  if (clientName.length > CLIENT_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: 'invalid_client_metadata',
      description: `client_name must be at most ${CLIENT_NAME_MAX_LENGTH} characters`,
    };
  }
  const uris = input.redirectUris;
  if (
    !Array.isArray(uris) ||
    uris.length === 0 ||
    !uris.every((u) => typeof u === 'string' && u.length > 0)
  ) {
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      description: 'redirect_uris must be a non-empty array of strings',
    };
  }
  if (uris.length > REDIRECT_URIS_MAX) {
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      description: `at most ${REDIRECT_URIS_MAX} redirect_uris are allowed`,
    };
  }
  for (const uri of uris as string[]) {
    if (uri.length > REDIRECT_URI_MAX_LENGTH || !isValidRegisterRedirectUri(uri)) {
      return {
        ok: false,
        error: 'invalid_redirect_uri',
        description: `redirect_uri "${uri.slice(0, 200)}" must be absolute https (or http on localhost)`,
      };
    }
  }
  return { ok: true, clientName, redirectUris: uris as string[] };
}
