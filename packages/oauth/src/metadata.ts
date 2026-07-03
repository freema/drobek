/**
 * Discovery metadata + origin helpers (U5). Pure functions so both the web
 * Authorization Server route and the mcp Resource Server can build consistent
 * metadata. No secrets, no DB.
 */
import { SCOPES } from './scopes.js';

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

/**
 * The AS issuer origin. Prefers PUBLIC_APP_URL / PUBLIC_ORIGIN; falls back to
 * the request's own origin (dev). Always without a trailing slash.
 */
export function authorizationServerIssuer(request?: Request): string {
  const env = process.env.PUBLIC_APP_URL || process.env.PUBLIC_ORIGIN;
  if (env && env.trim()) return stripTrailingSlash(env.trim());
  if (request) {
    const url = new URL(request.url);
    return `${url.protocol}//${url.host}`;
  }
  return 'http://localhost:3041';
}

/** OAuth 2.1 Authorization Server Metadata (RFC 8414). */
export function buildAuthorizationServerMetadata(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...SCOPES],
  };
}
