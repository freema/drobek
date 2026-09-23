/**
 * The drobek MCP endpoint (U5, M0-04, M0-05) — official TypeScript SDK over
 * Streamable HTTP at POST/GET/DELETE `/mcp`, behind the Bearer gate (OAuth
 * access token with the right audience, or a `drk_` API key).
 *
 * This module owns the transport, the session map and authentication; the
 * tool bodies live in @drobek/mcp (`registerAppTools`). A grant is bound to a
 * USER. Two independent checks run for every tool:
 *  - SCOPE — `TOOL_SCOPES` (scopes.ts) decides which tools exist for the
 *    grant: only those are registered, so tools/list shows exactly them and
 *    a call to any other tool fails. A session stays bound to the (user,
 *    scope) it was opened with.
 *  - MEMBERSHIP — every tool resolves the caller's role in the target app's
 *    workspace on the call (@drobek/mcp access.ts); an unknown app/workspace
 *    and a non-member answer the same `not_found`.
 */
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Express, Request, Response } from 'express';
import { coreVersion } from '@drobek/core';
import { registerAppTools, type RegisterOptions } from '@drobek/mcp';
import { toolAllowed } from '../scopes.js';
import { registerDocs } from './docs.js';
import { authenticate, send401, type AuthContext } from './oauth-resource.js';

/**
 * Build a fresh MCP server for one authenticated principal + granted scope.
 * `deps` is a test seam (lease store, compiler, clock) passed to @drobek/mcp.
 */
export function buildMcpServer(ctx: AuthContext, deps?: RegisterOptions['deps']): McpServer {
  const server = new McpServer(
    { name: 'drobek', version: coreVersion().version },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  // Docs resources (drobek://docs/*) + the guided prompt, scope-agnostic: a
  // connected agent can read the contract without web access.
  registerDocs(server);

  // Registration gate: a tool exists for this grant iff its scope was granted.
  registerAppTools(
    server,
    { userId: ctx.userId, email: ctx.email, superAdmin: ctx.superAdmin },
    { allow: (tool) => toolAllowed(ctx.scopes, tool), deps }
  );

  return server;
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  /** The session is pinned to the principal + scope its tools were built for. */
  userId: string;
  scope: string;
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
        'Bearer token or API key is invalid, expired, revoked, or bound to a different resource.'
      );
      return;
    }
    const ctx = auth.ctx;

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && sessions[sessionId]) {
      // A session may only be driven by the user AND scope it was opened for —
      // its tool set was registered for that scope.
      const open = sessions[sessionId];
      if (open.userId !== ctx.userId || open.scope !== ctx.scope) {
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
          sessions[id] = { transport, server, userId: ctx.userId, scope: ctx.scope };
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
