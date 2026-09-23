/**
 * The drobek MCP endpoint (U5, M0-04) — official TypeScript SDK over Streamable
 * HTTP at POST/GET/DELETE `/mcp`, behind the Bearer gate (OAuth access token
 * with the right audience, or a `drk_` API key).
 *
 * A grant is bound to a USER. Two independent checks run for every tool:
 *  - SCOPE — `TOOL_SCOPES` (scopes.ts) decides which tools exist for the
 *    grant: only those are registered, so tools/list shows exactly them and
 *    a call to any other tool fails. A session stays bound to the (user,
 *    scope) it was opened with.
 *  - MEMBERSHIP — every tool that targets a workspace resolves the caller's
 *    role in it on the call (resource/access.ts); unknown workspace, non-member
 *    and missing app all answer the same `not_found`.
 */
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { coreVersion } from '@drobek/core';
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
import { allowedTools, toolAllowed, type ToolName } from '../scopes.js';
import {
  listAppsForPrincipal,
  listPrincipalWorkspaces,
  resolveCallWorkspace,
  type CallWorkspace,
} from './access.js';
import { registerDocs } from './docs.js';
import { authenticate, send401, type AuthContext } from './oauth-resource.js';

function textResult(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/** Structured isError result `{ error, message }` (same shape as DataError/InsightsError). */
function errorResult(error: string, message: string) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify({ error, message }, null, 2) },
    ],
    isError: true,
  };
}

/**
 * The ONE answer for "unknown workspace", "not a member" and "no such app" —
 * byte-identical to the data/insights `not_found`, so none of them is an
 * enumeration oracle.
 */
function notFoundResult() {
  return errorResult('not_found', 'app not found');
}

/** Build a fresh MCP server for one authenticated principal + granted scope. */
export function buildMcpServer(ctx: AuthContext): McpServer {
  const server = new McpServer(
    { name: 'drobek', version: coreVersion().version },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  // M1b Agent DX (PHY-124): docs resources (drobek://docs/*) + guided prompts,
  // scope-agnostic so a connected agent can read the delivery-stack contract and
  // the add-data recipe without web access. Does not affect the tools.
  registerDocs(server);

  /** Registration gate: a tool exists for this grant iff its scope was granted. */
  const allow = (tool: ToolName): boolean => toolAllowed(ctx.scopes, tool);

  server.registerTool(
    'whoami',
    {
      description:
        'Return the authenticated drobek user, EVERY workspace they belong to (slug, name, kind, role), the granted MCP scope, and the tools it unlocks. Call this first to learn your workspace slugs.',
    },
    async () =>
      textResult({
        email: ctx.email,
        superAdmin: ctx.superAdmin,
        auth: ctx.kind,
        scope: ctx.scope,
        tools: allowedTools(ctx.scopes),
        workspaces: await listPrincipalWorkspaces(ctx),
      })
  );

  if (allow('list_apps')) {
    server.registerTool(
      'list_apps',
      {
        description:
          'List your apps across every workspace you belong to (each with its workspace slug), or only one workspace with `workspace`. Requires the read scope.',
        inputSchema: { workspace: z.string().optional() },
      },
      async ({ workspace }) => {
        const rows = await listAppsForPrincipal(ctx, workspace);
        if (rows === null) return errorResult('not_found', 'workspace not found');
        return textResult({
          ...(workspace !== undefined ? { workspace } : {}),
          count: rows.length,
          apps: rows,
        });
      }
    );
  }

  // ── U10 data tools (PHY-55/PHY-56) ─────────────────────────────────────────
  //
  // collection_define + record_create/update/delete need the write scope
  // (collection_define also an editor+ role); record_read/query need read. The
  // locator's workspace is authorized against the caller's membership.
  registerDataTools(server, ctx, allow);

  // ── PHY-123 agent-loop read tools ──────────────────────────────────────────
  //
  // app_errors + app_logs are READ-ONLY (read scope + any membership).
  registerInsightsTools(server, ctx, allow);

  return server;
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

/**
 * Run `fn` with the caller's access to `workspaceSlug`, or answer not_found.
 * The resolved workspace id is then pinned for the data/insights lookup, so
 * the app is resolved INSIDE the authorized workspace only.
 */
async function withWorkspace<T>(
  ctx: AuthContext,
  workspaceSlug: string,
  fn: (ws: CallWorkspace) => Promise<T>
): Promise<T | ReturnType<typeof notFoundResult>> {
  const ws = await resolveCallWorkspace(ctx, workspaceSlug);
  if (!ws) return notFoundResult();
  return fn(ws);
}

/** Register the U10 data tools the grant's scope allows. */
function registerDataTools(
  server: McpServer,
  ctx: AuthContext,
  allow: (tool: ToolName) => boolean
): void {
  const locatorFor = (
    locator: { workspace: string; slug: string },
    ws: CallWorkspace
  ) => ({
    wsSlug: locator.workspace,
    appSlug: locator.slug,
    requireWorkspaceId: ws.workspaceId,
  });

  if (allow('collection_define')) {
    server.registerTool(
      'collection_define',
      {
        description:
          'Create or update a collection: a REQUIRED JSON Schema (every write is validated against it) and an access mode (public-read | public-write | locked | owner-only). Idempotent by (app, name). Requires the write scope and an editor+ role in the workspace. owner-only is reserved for U11 end-user auth.',
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
      async ({ workspace, slug, name, jsonSchema, accessMode }) =>
        withWorkspace(ctx, workspace, async (ws) => {
          if (!roleAtLeast(ws.role, 'editor')) {
            return errorResult(
              'forbidden',
              'defining a collection requires an editor or workspace-admin role'
            );
          }
          return runDataTool(async () => {
            const app = await resolveApp({
              wsSlug: workspace,
              appSlug: slug,
              requireWorkspaceId: ws.workspaceId,
            });
            return defineCollection({ appId: app.appId, name, jsonSchema, accessMode });
          });
        })
    );
  }

  if (allow('record_create')) {
    server.registerTool(
      'record_create',
      {
        description:
          'Create a document in a collection. The document is validated against the collection JSON Schema (invalid → rejected), rate-limited, and quota-capped. Requires the write scope.',
        inputSchema: {
          locator: dataLocatorSchema,
          collection: z.string(),
          doc: z.record(z.string(), z.unknown()),
        },
      },
      async ({ locator, collection, doc }) =>
        withWorkspace(ctx, locator.workspace, (ws) =>
          runDataTool(() =>
            createRecord({
              locator: locatorFor(locator, ws),
              collection,
              caller: { authenticated: true, role: ws.role },
              doc,
            })
          )
        )
    );
  }

  if (allow('record_update')) {
    server.registerTool(
      'record_update',
      {
        description:
          'Patch a document (shallow-merge into the existing doc); the merged document is re-validated against the schema. Requires the write scope.',
        inputSchema: {
          locator: dataLocatorSchema,
          collection: z.string(),
          id: z.string(),
          patch: z.record(z.string(), z.unknown()),
        },
      },
      async ({ locator, collection, id, patch }) =>
        withWorkspace(ctx, locator.workspace, (ws) =>
          runDataTool(() =>
            updateRecord({
              locator: locatorFor(locator, ws),
              collection,
              caller: { authenticated: true, role: ws.role },
              id,
              patch,
            })
          )
        )
    );
  }

  if (allow('record_delete')) {
    server.registerTool(
      'record_delete',
      {
        description:
          'Soft-delete a document (excluded from every subsequent read/query; the row is retained). Requires the write scope.',
        inputSchema: {
          locator: dataLocatorSchema,
          collection: z.string(),
          id: z.string(),
        },
      },
      async ({ locator, collection, id }) =>
        withWorkspace(ctx, locator.workspace, (ws) =>
          runDataTool(() =>
            deleteRecord({
              locator: locatorFor(locator, ws),
              collection,
              caller: { authenticated: true, role: ws.role },
              id,
            })
          )
        )
    );
  }

  if (allow('record_read')) {
    server.registerTool(
      'record_read',
      {
        description:
          'Read a single document by id from a collection. Requires the read scope.',
        inputSchema: {
          locator: dataLocatorSchema,
          collection: z.string(),
          id: z.string(),
        },
      },
      async ({ locator, collection, id }) =>
        withWorkspace(ctx, locator.workspace, (ws) =>
          runDataTool(() =>
            readRecord({
              locator: locatorFor(locator, ws),
              collection,
              caller: { authenticated: true, role: ws.role },
              id,
            })
          )
        )
    );
  }

  if (allow('record_query')) {
    server.registerTool(
      'record_query',
      {
        description:
          'Query a collection: `where` equality filters + `sort` (both restricted to the schema properties + createdAt/updatedAt/id — unknown fields rejected), `limit`, and an opaque `cursor` for pagination. Soft-deleted docs are excluded. Requires the read scope.',
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
      async ({ locator, collection, where, sort, limit, cursor }) =>
        withWorkspace(ctx, locator.workspace, (ws) =>
          runDataTool(() =>
            queryRecords({
              locator: locatorFor(locator, ws),
              collection,
              caller: { authenticated: true, role: ws.role },
              where,
              sort,
              limit,
              cursor,
            })
          )
        )
    );
  }
}

/** Map a thrown InsightsError to a structured isError result; rethrow others. */
async function runInsightsTool(fn: () => Promise<unknown>) {
  try {
    return textResult(await fn());
  } catch (err) {
    if (err instanceof InsightsError) {
      return errorResult(err.code, err.message);
    }
    throw err;
  }
}

/**
 * Register the PHY-123 agent-loop READ tools (app_errors / app_logs): read
 * scope + any membership (viewer+) in the app's workspace. They never mutate.
 */
function registerInsightsTools(
  server: McpServer,
  ctx: AuthContext,
  allow: (tool: ToolName) => boolean
): void {
  if (allow('app_errors')) {
    server.registerTool(
      'app_errors',
      {
        description:
          'Read the recent client-side errors captured for an app (window.onerror + unhandledrejection), DEDUPED by message + stack head with occurrence counts, first/last-seen, the last URL, and a file:line hint. Use this after a change to close the fix loop. Read-only; requires the read scope and workspace membership.',
        inputSchema: {
          workspace: z.string(),
          slug: z.string(),
          since: z.string().optional(),
        },
      },
      async ({ workspace, slug, since }) =>
        withWorkspace(ctx, workspace, (ws) =>
          runInsightsTool(() =>
            queryAppErrorsByLocator({
              wsSlug: workspace,
              appSlug: slug,
              requireWorkspaceId: ws.workspaceId,
              since,
            })
          )
        )
    );
  }

  if (allow('app_logs')) {
    server.registerTool(
      'app_logs',
      {
        description:
          'Read the server-side serving signals for an app: request volume, 5xx count, the top 404-by-path (missing assets/routes), and the recent versions (compile status, which one is published). Use this to spot broken asset paths and correlate errors with a version. Read-only; requires the read scope and workspace membership.',
        inputSchema: {
          workspace: z.string(),
          slug: z.string(),
          since: z.string().optional(),
        },
      },
      async ({ workspace, slug, since }) =>
        withWorkspace(ctx, workspace, (ws) =>
          runInsightsTool(() =>
            queryAppLogsByLocator({
              wsSlug: workspace,
              appSlug: slug,
              requireWorkspaceId: ws.workspaceId,
              since,
            })
          )
        )
    );
  }
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
