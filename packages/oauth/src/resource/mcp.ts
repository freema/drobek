/**
 * The drobek MCP endpoint — official TypeScript SDK over
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
 *
 * A request is authenticated from its headers before its body is read. A POST
 * body is parsed here, capped at MCP_MAX_BODY_BYTES: an oversized one answers
 * 413 with a JSON-RPC error saying how to split the write, malformed JSON a
 * JSON-RPC parse error (-32700). A failure answers JSON-RPC -32603 and goes to
 * the log and the error reporter. Every request leaves one access-log line
 * when its response closes — names, status, timing and ids, never arguments,
 * credentials, headers or bodies.
 *
 * Sessions live in this process only: after a restart a client's session id
 * answers 404 and the client initializes a new session.
 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express, { type Express, type Request, type Response } from 'express';
import { SERVER_INSTRUCTIONS } from '@drobek/agent-dx';
import { coreVersion, createConsoleLogger, reportError, type Logger } from '@drobek/core';
import { dbErrorForLog } from '@drobek/db';
import { mcpMaxBodyBytes, registerAppTools, type RegisterOptions } from '@drobek/mcp';
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
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: SERVER_INSTRUCTIONS }
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

export interface McpEndpointOptions {
  /** Max bytes of one request body. Default: MCP_MAX_BODY_BYTES (@drobek/mcp `mcpMaxBodyBytes`). */
  maxBodyBytes?: number;
  /** The access log and the failures. Default: the console logger `mcp`. */
  log?: Logger;
  /** Builds the MCP server of a new session. Default: `buildMcpServer`. */
  buildServer?: (ctx: AuthContext) => McpServer;
}

/** Longest JSON-RPC method or tool name the access log keeps. */
const LOG_NAME_MAX = 64;
/** Characters of the session id the access log keeps. */
const LOG_SESSION_CHARS = 8;

interface AccessEntry {
  started: number;
  rpc?: string;
  tool?: string;
  session?: string;
  userId?: string;
}

function logName(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value.slice(0, LOG_NAME_MAX) : undefined;
}

/** The JSON-RPC method(s) of a body and, for tools/call, the tool name(s) — never params or arguments. */
function rpcSummary(body: unknown): Pick<AccessEntry, 'rpc' | 'tool'> {
  const methods: string[] = [];
  const tools: string[] = [];
  for (const message of Array.isArray(body) ? body : [body]) {
    if (!message || typeof message !== 'object') continue;
    const { method, params } = message as { method?: unknown; params?: unknown };
    const name = logName(method);
    if (!name) continue;
    methods.push(name);
    if (name === 'tools/call' && params && typeof params === 'object') {
      const tool = logName((params as { name?: unknown }).name);
      if (tool) tools.push(tool);
    }
  }
  return {
    ...(methods.length > 0 ? { rpc: methods.join(',') } : {}),
    ...(tools.length > 0 ? { tool: tools.join(',') } : {}),
  };
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

/** The JSON-RPC answer to a body the parser refused; null for an error that is not about the body. */
function bodyErrorAnswer(err: unknown, maxBodyBytes: number): { status: number; code: number; message: string } | null {
  const { type, status } = (err ?? {}) as { type?: unknown; status?: unknown };
  if (type === 'entity.too.large') {
    return {
      status: 413,
      code: -32600,
      message: `Request body over ${maxBodyBytes} bytes, the largest MCP request this server takes (MCP_MAX_BODY_BYTES). Nothing was written: split the write into several write_files calls, or send edits instead of whole files.`,
    };
  }
  if (type === 'entity.parse.failed') {
    return { status: 400, code: -32700, message: 'Parse error: the request body is not valid JSON.' };
  }
  if (typeof type === 'string' && typeof status === 'number' && status >= 400 && status < 500) {
    return { status, code: -32600, message: 'Invalid request: the request body could not be read.' };
  }
  return null;
}

/** Mount the Bearer-protected Streamable HTTP MCP endpoint on the app. */
export function mountMcpEndpoint(app: Express, opts: McpEndpointOptions = {}): void {
  const sessions = new Map<string, McpSession>();
  const maxBodyBytes = opts.maxBodyBytes ?? mcpMaxBodyBytes(process.env);
  const log = opts.log ?? createConsoleLogger('mcp');
  const build = opts.buildServer ?? ((ctx: AuthContext) => buildMcpServer(ctx));
  const parseJson = express.json({ limit: maxBodyBytes });

  const readBody = (req: Request, res: Response): Promise<unknown> =>
    new Promise((resolve) => parseJson(req, res, (err?: unknown) => resolve(err)));

  async function handle(req: Request, res: Response, entry: AccessEntry): Promise<void> {
    const presented = req.headers['mcp-session-id'];
    const sessionId = typeof presented === 'string' && presented !== '' ? presented : undefined;
    if (sessionId) entry.session = sessionId.slice(0, LOG_SESSION_CHARS);

    const auth = await authenticate(req);
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
    entry.userId = ctx.userId;

    if (req.method === 'POST') {
      const bodyError = await readBody(req, res);
      if (bodyError) {
        const answer = bodyErrorAnswer(bodyError, maxBodyBytes);
        if (!answer) throw bodyError;
        jsonRpcError(res, answer.status, answer.code, answer.message);
        return;
      }
      Object.assign(entry, rpcSummary(req.body));
    }

    const open = sessionId ? sessions.get(sessionId) : undefined;
    if (open) {
      // A session may only be driven by the user AND scope it was opened for —
      // its tool set was registered for that scope.
      if (open.userId !== ctx.userId || open.scope !== ctx.scope) {
        send401(res, 'invalid_token', 'Token does not match this MCP session.');
        return;
      }
      await open.transport.handleRequest(req, res, req.body);
      return;
    }
    if (sessionId) {
      jsonRpcError(res, 404, -32001, 'MCP session not found — reconnect.');
      return;
    }

    if (req.method === 'POST' && isInitializeRequest(req.body)) {
      const server = build(ctx);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, userId: ctx.userId, scope: ctx.scope });
          entry.session = id.slice(0, LOG_SESSION_CHARS);
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) sessions.delete(sid);
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

  function fail(req: Request, res: Response, err: unknown): void {
    log.error('mcp request failed', { method: req.method, error: dbErrorForLog(err, { stack: true }) });
    void reportError({
      message: 'mcp request failed',
      error: err,
      context: { kind: 'http', method: req.method, route: '/mcp', status: 500 },
    });
    if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal error');
    else if (!res.writableEnded) res.end();
  }

  const route = (req: Request, res: Response): void => {
    const entry: AccessEntry = { started: performance.now() };
    res.once('close', () => {
      log.info('mcp request', {
        method: req.method,
        ...(entry.rpc ? { rpc: entry.rpc } : {}),
        ...(entry.tool ? { tool: entry.tool } : {}),
        status: res.statusCode,
        duration_ms: Math.round(performance.now() - entry.started),
        ...(entry.session ? { session: entry.session } : {}),
        ...(entry.userId ? { user_id: entry.userId } : {}),
        ...(res.writableFinished ? {} : { aborted: true }),
      });
    });
    handle(req, res, entry).catch((err: unknown) => fail(req, res, err));
  };
  app.post('/mcp', route);
  app.get('/mcp', route);
  app.delete('/mcp', route);
}
