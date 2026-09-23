/**
 * Discovery metadata + origin helpers (U5, M0-04). Pure functions so the
 * Authorization Server routes and the MCP Resource Server build consistent
 * identities from ONE place. No secrets, no DB.
 */
import { SCOPES } from './scopes.js';

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

/**
 * The AS issuer origin. Prefers PUBLIC_APP_URL / PUBLIC_ORIGIN; falls back to
 * the request's own origin (dev). Always without a trailing slash. This is
 * also the RFC 9207 `iss` value appended to every authorization response.
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

/** The drobek Authorization Server issuer origin (env-only form). */
export function authorizationServer(): string {
  return authorizationServerIssuer();
}

/**
 * Canonical MCP resource identifier (RFC 8707/9728) — the MCP endpoint URL
 * itself and the ONLY audience the Resource Server accepts. One process serves
 * the dashboard, the AS and the RS, so it defaults to `PUBLIC_APP_URL + /mcp`;
 * `PUBLIC_MCP_URL` (a full endpoint URL) overrides it.
 */
export function mcpResourceUri(): string {
  const raw = process.env.PUBLIC_MCP_URL?.trim();
  if (raw) return stripTrailingSlash(raw);
  return `${authorizationServer()}/mcp`;
}

/** True when a client-requested `resource` names this MCP endpoint (trailing slashes ignored). */
export function isMcpResource(requested: string): boolean {
  return stripTrailingSlash(requested.trim()) === mcpResourceUri();
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
    // An https client_id is a Client ID Metadata Document URL (fetched, SSRF-guarded).
    client_id_metadata_document_supported: true,
    // RFC 9207: every authorization response carries `iss`.
    authorization_response_iss_parameter_supported: true,
  };
}
