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
  DataError,
  createRecord,
  defineCollection,
  deleteRecord,
  queryRecords,
  readRecord,
  resolveApp,
  updateRecord,
} from '@drobek/data';
import {
  InsightsError,
  queryAppErrorsByLocator,
  queryAppLogsByLocator,
} from '@drobek/insights';
import { roleAtLeast } from '@drobek/tenancy';
import { hasScope } from '../scopes.js';
import type { OAuthRole } from '../store.server.js';
import { registerDocs } from './docs.js';
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
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  // M1b Agent DX (PHY-124): docs resources (drobek://docs/*) + guided prompts,
  // scope-agnostic so a connected agent can read the delivery-stack contract and
  // the add-data recipe without web access. Does not affect the tools.
  registerDocs(server);

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

  // ── U10 data tools (PHY-55/PHY-56) ─────────────────────────────────────────
  //
  // collection_define + record_create/update/delete require data:write (+ a
  // live editor role); record_read/query require data:read. The locator's
  // workspace MUST be the token's bound workspace (cross-workspace rejected).
  registerDataTools(server, ctx);

  // ── PHY-123 agent-loop read tools ──────────────────────────────────────────
  //
  // app_errors + app_logs are READ-ONLY (apps:read + any live membership). Both
  // re-resolve the app inside the token's workspace (cross-workspace rejected).
  registerInsightsTools(server, ctx);

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

/** Structured isError result for a plain forbidden (non-DataError). */
function forbiddenResult(message: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ error: 'forbidden', message }, null, 2),
      },
    ],
    isError: true,
  };
}

/** Map a thrown DataError to a structured isError result; rethrow others. */
async function runDataTool(fn: () => Promise<unknown>) {
  try {
    return textResult(await fn());
  } catch (err) {
    if (err instanceof DataError) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { error: err.code, message: err.message, details: err.details },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
    throw err;
  }
}

const dataLocatorSchema = z.object({
  workspace: z.string(),
  slug: z.string(),
});

/** Register the U10 data tools according to the token's granted scope. */
function registerDataTools(server: McpServer, ctx: AuthContext): void {
  const canWrite = hasScope(ctx.scope, 'data:write');
  const canRead = hasScope(ctx.scope, 'data:read');

  /** Re-check membership + resolve the current role, or an isError result. */
  async function requireRole(): Promise<OAuthRole | { isError: true; result: ReturnType<typeof accessRevokedResult> }> {
    if (!(await stillGrantsRole(ctx))) {
      return { isError: true, result: accessRevokedResult() };
    }
    const role = await currentEffectiveRole(ctx);
    if (!role) return { isError: true, result: accessRevokedResult() };
    return role;
  }

  if (canWrite) {
    server.registerTool(
      'collection_define',
      {
        description:
          'Create or update a collection: a REQUIRED JSON Schema (every write is validated against it) and an access mode (public-read | public-write | locked | owner-only). Idempotent by (app, name). Requires data:write and an editor+ role. owner-only is reserved for U11 end-user auth.',
        inputSchema: {
          workspace: z.string(),
          slug: z.string(),
          name: z.string(),
          jsonSchema: z.record(z.string(), z.unknown()),
          accessMode: z.enum([
            'public-read',
            'public-write',
            'locked',
            'owner-only',
          ]),
        },
      },
      async ({ workspace, slug, name, jsonSchema, accessMode }) => {
        const role = await requireRole();
        if (typeof role === 'object') return role.result;
        if (!roleAtLeast(role, 'editor')) {
          return forbiddenResult(
            'defining a collection requires an editor or workspace-admin role'
          );
        }
        return runDataTool(async () => {
          const app = await resolveApp({
            wsSlug: workspace,
            appSlug: slug,
            requireWorkspaceId: ctx.workspaceId,
          });
          return defineCollection({ appId: app.appId, name, jsonSchema, accessMode });
        });
      }
    );

    server.registerTool(
      'record_create',
      {
        description:
          'Create a document in a collection. The document is validated against the collection JSON Schema (invalid → rejected), rate-limited, and quota-capped. Requires data:write.',
        inputSchema: {
          locator: dataLocatorSchema,
          collection: z.string(),
          doc: z.record(z.string(), z.unknown()),
        },
      },
      async ({ locator, collection, doc }) => {
        const role = await requireRole();
        if (typeof role === 'object') return role.result;
        return runDataTool(() =>
          createRecord({
            locator: {
              wsSlug: locator.workspace,
              appSlug: locator.slug,
              requireWorkspaceId: ctx.workspaceId,
            },
            collection,
            caller: { authenticated: true, role },
            doc,
          })
        );
      }
    );

    server.registerTool(
      'record_update',
      {
        description:
          'Patch a document (shallow-merge into the existing doc); the merged document is re-validated against the schema. Requires data:write.',
        inputSchema: {
          locator: dataLocatorSchema,
          collection: z.string(),
          id: z.string(),
          patch: z.record(z.string(), z.unknown()),
        },
      },
      async ({ locator, collection, id, patch }) => {
        const role = await requireRole();
        if (typeof role === 'object') return role.result;
        return runDataTool(() =>
          updateRecord({
            locator: {
              wsSlug: locator.workspace,
              appSlug: locator.slug,
              requireWorkspaceId: ctx.workspaceId,
            },
            collection,
            caller: { authenticated: true, role },
            id,
            patch,
          })
        );
      }
    );

    server.registerTool(
      'record_delete',
      {
        description:
          'Soft-delete a document (excluded from every subsequent read/query; the row is retained). Requires data:write.',
        inputSchema: {
          locator: dataLocatorSchema,
          collection: z.string(),
          id: z.string(),
        },
      },
      async ({ locator, collection, id }) => {
        const role = await requireRole();
        if (typeof role === 'object') return role.result;
        return runDataTool(() =>
          deleteRecord({
            locator: {
              wsSlug: locator.workspace,
              appSlug: locator.slug,
              requireWorkspaceId: ctx.workspaceId,
            },
            collection,
            caller: { authenticated: true, role },
            id,
          })
        );
      }
    );
  }

  if (canRead) {
    server.registerTool(
      'record_read',
      {
        description:
          'Read a single document by id from a collection. Requires data:read.',
        inputSchema: {
          locator: dataLocatorSchema,
          collection: z.string(),
          id: z.string(),
        },
      },
      async ({ locator, collection, id }) => {
        const role = await requireRole();
        if (typeof role === 'object') return role.result;
        return runDataTool(() =>
          readRecord({
            locator: {
              wsSlug: locator.workspace,
              appSlug: locator.slug,
              requireWorkspaceId: ctx.workspaceId,
            },
            collection,
            caller: { authenticated: true, role },
            id,
          })
        );
      }
    );

    server.registerTool(
      'record_query',
      {
        description:
          'Query a collection: `where` equality filters + `sort` (both restricted to the schema properties + createdAt/updatedAt/id — unknown fields rejected), `limit`, and an opaque `cursor` for pagination. Soft-deleted docs are excluded. Requires data:read.',
        inputSchema: {
          locator: dataLocatorSchema,
          collection: z.string(),
          where: z.record(z.string(), z.unknown()).optional(),
          sort: z
            .object({ field: z.string(), dir: z.enum(['asc', 'desc']).optional() })
            .optional(),
          limit: z.number().int().positive().optional(),
          cursor: z.string().optional(),
        },
      },
      async ({ locator, collection, where, sort, limit, cursor }) => {
        const role = await requireRole();
        if (typeof role === 'object') return role.result;
        return runDataTool(() =>
          queryRecords({
            locator: {
              wsSlug: locator.workspace,
              appSlug: locator.slug,
              requireWorkspaceId: ctx.workspaceId,
            },
            collection,
            caller: { authenticated: true, role },
            where,
            sort,
            limit,
            cursor,
          })
        );
      }
    );
  }
}

/** Map a thrown InsightsError to a structured isError result; rethrow others. */
async function runInsightsTool(fn: () => Promise<unknown>) {
  try {
    return textResult(await fn());
  } catch (err) {
    if (err instanceof InsightsError) {
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

/**
 * Register the PHY-123 agent-loop READ tools (app_errors / app_logs). Both are
 * gated on apps:read + any live membership (role ≥ viewer), and the locator is
 * re-resolved INSIDE the token's workspace so a cross-workspace read is rejected
 * as not_found. They never mutate anything.
 */
function registerInsightsTools(server: McpServer, ctx: AuthContext): void {
  if (!hasScope(ctx.scope, 'apps:read')) return;

  server.registerTool(
    'app_errors',
    {
      description:
        'Read the recent client-side errors captured for an app (window.onerror + unhandledrejection), DEDUPED by message + stack head with occurrence counts, first/last-seen, the last URL, and a file:line hint. Use this after a change to close the fix loop. Read-only; requires apps:read and workspace membership.',
      inputSchema: {
        workspace: z.string(),
        slug: z.string(),
        since: z.string().optional(),
      },
    },
    async ({ workspace, slug, since }) => {
      if (!(await stillGrantsRole(ctx))) return accessRevokedResult();
      const role = await currentEffectiveRole(ctx);
      if (!role) return accessRevokedResult();
      return runInsightsTool(() =>
        queryAppErrorsByLocator({
          wsSlug: workspace,
          appSlug: slug,
          requireWorkspaceId: ctx.workspaceId,
          since,
        })
      );
    }
  );

  server.registerTool(
    'app_logs',
    {
      description:
        'Read the server-side serving signals for an app: request volume, 5xx count, the top 404-by-path (missing assets/routes), and the recent versions (compile status, which one is published). Use this to spot broken asset paths and correlate errors with a version. Read-only; requires apps:read and workspace membership.',
      inputSchema: {
        workspace: z.string(),
        slug: z.string(),
        since: z.string().optional(),
      },
    },
    async ({ workspace, slug, since }) => {
      if (!(await stillGrantsRole(ctx))) return accessRevokedResult();
      const role = await currentEffectiveRole(ctx);
      if (!role) return accessRevokedResult();
      return runInsightsTool(() =>
        queryAppLogsByLocator({
          wsSlug: workspace,
          appSlug: slug,
          requireWorkspaceId: ctx.workspaceId,
          since,
        })
      );
    }
  );
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
