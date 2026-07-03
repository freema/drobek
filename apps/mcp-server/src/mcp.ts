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
import { coreVersion } from '@drobek/core';
import { apps, getDb } from '@drobek/db';
import { hasScope } from '@drobek/oauth';
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

  return server;
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
