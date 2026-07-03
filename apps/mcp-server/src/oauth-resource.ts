/**
 * mcp-server as an OAuth 2.1 Protected Resource (U5, PHY-71/PHY-53).
 *
 * The RS never mints tokens — it validates the Bearer against the drobek AS's
 * token store (@drobek/oauth) AND enforces RFC 8707: the token's `audience`
 * MUST equal THIS resource's canonical URI. Missing/invalid tokens get a 401
 * with a WWW-Authenticate challenge pointing at the protected-resource
 * metadata, per the MCP spec.
 */
import type { Request, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { getDb, memberships, users, workspaces } from '@drobek/db';
import {
  SCOPES,
  validateAccessToken,
  type OAuthRole,
} from '@drobek/oauth';

/** Canonical resource identifier (also the required token audience). */
export function mcpResourceUri(): string {
  const raw = process.env.PUBLIC_MCP_URL?.trim() || 'http://localhost:3042';
  return raw.replace(/\/+$/, '');
}

/** The drobek Authorization Server issuer origin. */
export function authorizationServer(): string {
  const raw =
    process.env.PUBLIC_APP_URL?.trim() ||
    process.env.PUBLIC_ORIGIN?.trim() ||
    'http://localhost:3041';
  return raw.replace(/\/+$/, '');
}

/** RFC 9728 protected-resource metadata body. */
export function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: mcpResourceUri(),
    authorization_servers: [authorizationServer()],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
  };
}

function resourceMetadataUrl(): string {
  return `${mcpResourceUri()}/.well-known/oauth-protected-resource`;
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

export interface AuthContext {
  userId: string;
  email: string;
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  role: OAuthRole;
  scope: string;
  audience: string;
  superAdmin: boolean;
}

export type AuthOutcome =
  | { kind: 'ok'; ctx: AuthContext }
  | { kind: 'no_token' }
  | { kind: 'invalid' };

const ROLE_RANK: Record<OAuthRole, number> = {
  viewer: 0,
  editor: 1,
  'workspace-admin': 2,
};

/** SUPERADMIN_EMAIL is a comma-separated global override (mirrors @drobek/auth). */
export function isSuperAdminEmail(email: string): boolean {
  const targets = (process.env.SUPERADMIN_EMAIL ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return targets.length > 0 && targets.includes(email.trim().toLowerCase());
}

/**
 * Validate the Bearer + audience, then hydrate the workspace/user identity the
 * token is bound to. audience mismatch / expiry / revocation all collapse to
 * `invalid` (→ 401).
 */
export async function authenticate(req: Request): Promise<AuthOutcome> {
  const bearer = extractBearer(req);
  if (!bearer) return { kind: 'no_token' };

  const claims = await validateAccessToken(bearer, {
    audience: mcpResourceUri(),
  });
  if (!claims) return { kind: 'invalid' };

  const db = getDb();
  const [u] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, claims.userId))
    .limit(1);
  const [w] = await db
    .select({ slug: workspaces.slug, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, claims.workspaceId))
    .limit(1);
  if (!u || !w) return { kind: 'invalid' };

  return {
    kind: 'ok',
    ctx: {
      userId: claims.userId,
      email: u.email,
      workspaceId: claims.workspaceId,
      workspaceSlug: w.slug,
      workspaceName: w.name,
      role: claims.role,
      scope: claims.scope,
      audience: claims.audience,
      superAdmin: isSuperAdminEmail(u.email),
    },
  };
}

/**
 * Defense-in-depth per-tool-call re-check: the membership must STILL exist and
 * still grant at least the role the token was bound to (super-admin overrides).
 * A revoked/downgraded membership silently loses access even on a live token.
 */
export async function stillGrantsRole(ctx: AuthContext): Promise<boolean> {
  if (ctx.superAdmin) return true;
  const [m] = await getDb()
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, ctx.userId),
        eq(memberships.workspaceId, ctx.workspaceId)
      )
    )
    .limit(1);
  if (!m) return false;
  return ROLE_RANK[m.role as OAuthRole] >= ROLE_RANK[ctx.role];
}
