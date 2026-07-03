/**
 * The drobek MCP endpoint (U5, PHY-71) — official TypeScript SDK over Streamable
 * HTTP at POST/GET/DELETE `/mcp`, behind the OAuth Bearer + audience gate.
 *
 * Tools for U5:
 *  - whoami    — always exposed; returns the authed email + workspace + role +
 *                granted scope.
 *  - list_apps — exposed only when the token carries `apps:read`; lists the
 *                apps in the bound workspace (may be empty).
 *
 * tools/list therefore reflects the granted scope. Every tool re-checks the
 * membership at call time (defense-in-depth) before doing any work.
 */
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { and, eq, isNull } from 'drizzle-orm';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { coreVersion } from '@drobek/core';
import { apps, getDb, memberships } from '@drobek/db';
import {
  DeployError,
  deployCommit,
  deployInit,
  deployStatus,
  rollback,
} from '@drobek/deploy';
import { hasScope } from '../scopes.js';
import type { OAuthRole } from '../store.server.js';
import {
  authenticate,
  send401,
  stillGrantsRole,
  type AuthContext,
} from './oauth-resource.js';

function textResult(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function accessRevokedResult() {
  return {
    content: [
      {
        type: 'text' as const,
        text: 'Access denied: your membership in this workspace is no longer sufficient.',
      },
    ],
    isError: true,
  };
}

/** Build a fresh MCP server bound to one token's auth context + scope. */
export function buildMcpServer(ctx: AuthContext): McpServer {
  const server = new McpServer(
    { name: 'drobek', version: coreVersion().version },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    'whoami',
    {
      description:
        'Return the authenticated drobek user, the bound workspace + role, and the granted MCP scope.',
    },
    async () => {
      if (!(await stillGrantsRole(ctx))) return accessRevokedResult();
      return textResult({
        email: ctx.email,
        workspace: ctx.workspaceSlug,
        workspaceName: ctx.workspaceName,
        role: ctx.role,
        scope: ctx.scope,
        superAdmin: ctx.superAdmin,
      });
    }
  );

  if (hasScope(ctx.scope, 'apps:read')) {
    server.registerTool(
      'list_apps',
      {
        description:
          'List the apps in the bound workspace (requires the apps:read scope).',
      },
      async () => {
        if (!(await stillGrantsRole(ctx))) return accessRevokedResult();
        const rows = await getDb()
          .select({
            slug: apps.slug,
            status: apps.status,
            visibility: apps.visibility,
            createdAt: apps.createdAt,
          })
          .from(apps)
          .where(
            and(eq(apps.workspaceId, ctx.workspaceId), isNull(apps.deletedAt))
          )
          .orderBy(apps.createdAt);
        return textResult({
          workspace: ctx.workspaceSlug,
          count: rows.length,
          apps: rows,
        });
      }
    );
  }

  // ── U6 deploy tools (PHY-57) ───────────────────────────────────────────────
  //
  // deploy_init / deploy_commit / rollback require deploy:write; deploy_status
  // accepts apps:read. Every call re-resolves the CURRENT membership role (not
  // just the token's bound role) so a downgrade loses access immediately and an
  // upgrade is honored; the deploy functions themselves enforce role >= editor.
  registerDeployTools(server, ctx);

  return server;
}

/** Resolve the caller's CURRENT effective role in the bound workspace. */
async function currentEffectiveRole(ctx: AuthContext): Promise<OAuthRole | null> {
  if (ctx.superAdmin) return 'workspace-admin';
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
  return (m?.role as OAuthRole | undefined) ?? null;
}

const manifestEntrySchema = z.object({
  path: z.string(),
  sha256: z.string(),
  bytes: z.number().int().nonnegative(),
});

/** Map a thrown DeployError to a structured isError tool result; rethrow others. */
async function runDeployTool(fn: () => Promise<unknown>) {
  try {
    return textResult(await fn());
  } catch (err) {
    if (err instanceof DeployError) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: err.code, message: err.message }, null, 2),
          },
        ],
        isError: true,
      };
    }
    throw err;
  }
}

/** Register the U6 deploy tools according to the token's granted scope. */
function registerDeployTools(server: McpServer, ctx: AuthContext): void {
  const canDeploy = hasScope(ctx.scope, 'deploy:write');
  const canReadApps = hasScope(ctx.scope, 'apps:read');

  if (canDeploy) {
    server.registerTool(
      'deploy_init',
      {
        description:
          'Begin a deploy: validate the file manifest ({path, sha256, bytes}[] — an index.html at the root is required), create or target the app (slug from name, overridable), and return presigned PUT URLs for ONLY the files whose content is not already stored (content-hash dedup). Requires deploy:write and an editor+ role.',
        inputSchema: {
          name: z.string().optional(),
          slug: z.string().optional(),
          manifest: z.array(manifestEntrySchema).min(1),
        },
      },
      async ({ name, slug, manifest }) => {
        if (!(await stillGrantsRole(ctx))) return accessRevokedResult();
        const role = await currentEffectiveRole(ctx);
        if (!role) return accessRevokedResult();
        return runDeployTool(() =>
          deployInit({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            workspaceSlug: ctx.workspaceSlug,
            role,
            name,
            slug,
            manifest,
          })
        );
      }
    );

    server.registerTool(
      'deploy_commit',
      {
        description:
          'Finalize a deploy after its files are uploaded: verifies every manifest blob is stored, enqueues the build/lint/activate job, and returns the queued state. Poll deploy_status for progress. Requires deploy:write and an editor+ role.',
        inputSchema: { deployId: z.string() },
      },
      async ({ deployId }) => {
        if (!(await stillGrantsRole(ctx))) return accessRevokedResult();
        const role = await currentEffectiveRole(ctx);
        if (!role) return accessRevokedResult();
        return runDeployTool(() =>
          deployCommit({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            role,
            deployId,
          })
        );
      }
    );

    server.registerTool(
      'rollback',
      {
        description:
          'Roll an app back to a prior ready deploy by repointing its active version (defaults to the previous good deploy; pass toDeployId to target a specific one). Requires deploy:write and an editor+ role.',
        inputSchema: { slug: z.string(), toDeployId: z.string().optional() },
      },
      async ({ slug, toDeployId }) => {
        if (!(await stillGrantsRole(ctx))) return accessRevokedResult();
        const role = await currentEffectiveRole(ctx);
        if (!role) return accessRevokedResult();
        return runDeployTool(() =>
          rollback({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            role,
            slug,
            toDeployId,
          })
        );
      }
    );
  }

  if (canDeploy || canReadApps) {
    server.registerTool(
      'deploy_status',
      {
        description:
          'Report a deploy pipeline state (awaiting_upload → queued → linting → storing → activating → ready | failed), whether it is the app’s active version, its URL, and any lint report/error. Requires apps:read.',
        inputSchema: { deployId: z.string() },
      },
      async ({ deployId }) => {
        if (!(await stillGrantsRole(ctx))) return accessRevokedResult();
        const role = await currentEffectiveRole(ctx);
        if (!role) return accessRevokedResult();
        return runDeployTool(() =>
          deployStatus({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            role,
            deployId,
          })
        );
      }
    );
  }
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  userId: string;
}

function jsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string
): void {
  if (res.headersSent) return;
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

/** Mount the Bearer-protected Streamable HTTP MCP endpoint on the app. */
export function mountMcpEndpoint(app: Express): void {
  const sessions: Record<string, McpSession> = {};

  async function handle(req: Request, res: Response): Promise<void> {
    let auth;
    try {
      auth = await authenticate(req);
    } catch {
      jsonRpcError(res, 500, -32603, 'Internal error');
      return;
    }
    if (auth.kind === 'no_token') {
      send401(res);
      return;
    }
    if (auth.kind === 'invalid') {
      send401(
        res,
        'invalid_token',
        'Bearer token is invalid, expired, revoked, or bound to a different resource.'
      );
      return;
    }
    const ctx = auth.ctx;

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && sessions[sessionId]) {
      // A session may only be driven by the user it was opened for.
      if (sessions[sessionId].userId !== ctx.userId) {
        send401(res, 'invalid_token', 'Token does not match this MCP session.');
        return;
      }
      await sessions[sessionId].transport.handleRequest(req, res, req.body);
      return;
    }
    if (sessionId && !sessions[sessionId]) {
      jsonRpcError(res, 404, -32001, 'MCP session not found — reconnect.');
      return;
    }

    if (req.method === 'POST' && isInitializeRequest(req.body)) {
      const server = buildMcpServer(ctx);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions[id] = { transport, server, userId: ctx.userId };
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) delete sessions[sid];
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    jsonRpcError(
      res,
      400,
      -32000,
      'Missing or invalid MCP session — send an initialize request first.'
    );
  }

  app.post('/mcp', (req, res) => {
    void handle(req, res);
  });
  app.get('/mcp', (req, res) => {
    void handle(req, res);
  });
  app.delete('/mcp', (req, res) => {
    void handle(req, res);
  });
}
