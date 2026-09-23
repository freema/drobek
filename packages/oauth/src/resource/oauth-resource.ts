/**
 * The MCP endpoint as an OAuth 2.1 Protected Resource (U5, M0-04).
 *
 * The RS never mints tokens — it validates the Bearer against the drobek AS's
 * token store and enforces RFC 8707: an OAuth access token's `audience` MUST
 * equal THIS resource's canonical URI. A Bearer starting with `drk_` is a
 * personal API key instead (same path, same scope model, no audience).
 * Missing/invalid credentials get a 401 with a WWW-Authenticate challenge
 * pointing at the protected-resource metadata, per the MCP spec.
 *
 * Both credentials are bound to a USER, never to a workspace: the tools
 * resolve the caller's membership in the targeted workspace on every call
 * (resource/access.ts).
 */
import type { Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { isSuperAdmin } from '@drobek/auth';
import { getDb, users } from '@drobek/db';
import { looksLikeApiKey, validateApiKey } from '../api-keys.server.js';
import { authorizationServer, mcpResourceUri } from '../metadata.js';
import { knownScopes, SCOPES, type Scope } from '../scopes.js';
import { validateAccessToken } from '../tokens.server.js';

export { authorizationServer, mcpResourceUri } from '../metadata.js';

/** RFC 9728 protected-resource metadata body. */
export function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: mcpResourceUri(),
    authorization_servers: [authorizationServer()],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
  };
}

/**
 * RFC 9728 §3.1: the well-known suffix is inserted between the origin and the
 * resource path (`https://x/mcp` → `https://x/.well-known/oauth-protected-resource/mcp`).
 */
export function resourceMetadataUrl(): string {
  const url = new URL(mcpResourceUri());
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

/** MCP-spec 401: WWW-Authenticate Bearer + resource_metadata pointer. */
export function send401(
  res: Response,
  error?: string,
  description?: string
): void {
  const parts = [`Bearer resource_metadata="${resourceMetadataUrl()}"`];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description}"`);
  res.setHeader('WWW-Authenticate', parts.join(', '));
  res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: description ?? 'Authorization required' },
    id: null,
  });
}

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/** The authenticated principal of one MCP request. */
export interface AuthContext {
  /** Which credential authenticated the call. */
  kind: 'oauth' | 'api_key';
  /** Row id of the access token / API key (never the secret). */
  credentialId: string;
  userId: string;
  email: string;
  /** Global SUPERADMIN_EMAIL override: reaches every workspace. */
  superAdmin: boolean;
  /** Granted scope, space-delimited wire form. */
  scope: string;
  /** Granted scope, parsed (known scopes only). */
  scopes: Scope[];
  /** The OAuth token's RFC 8707 audience; null for an API key. */
  audience: string | null;
}

export type AuthOutcome =
  | { kind: 'ok'; ctx: AuthContext }
  | { kind: 'no_token' }
  | { kind: 'invalid' };

/**
 * Validate the Bearer (OAuth access token + audience, or API key), then load
 * the user it is bound to. Unknown / expired / revoked / wrong-audience all
 * collapse to `invalid` (→ 401 invalid_token).
 */
export async function authenticate(req: Request): Promise<AuthOutcome> {
  const bearer = extractBearer(req);
  if (!bearer) return { kind: 'no_token' };

  let claims: { id: string; userId: string; scope: string; audience: string | null };
  let kind: AuthContext['kind'];
  if (looksLikeApiKey(bearer)) {
    const key = await validateApiKey(bearer);
    if (!key) return { kind: 'invalid' };
    claims = { ...key, audience: null };
    kind = 'api_key';
  } else {
    const token = await validateAccessToken(bearer, { audience: mcpResourceUri() });
    if (!token) return { kind: 'invalid' };
    claims = token;
    kind = 'oauth';
  }

  const [u] = await getDb()
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, claims.userId))
    .limit(1);
  if (!u) return { kind: 'invalid' };

  return {
    kind: 'ok',
    ctx: {
      kind,
      credentialId: claims.id,
      userId: claims.userId,
      email: u.email,
      superAdmin: isSuperAdmin(u.email),
      scope: claims.scope,
      scopes: knownScopes(claims.scope),
      audience: claims.audience,
    },
  };
}
