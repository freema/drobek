/**
 * The drobek MCP endpoint — the official TypeScript SDK's `createMcpHandler`
 * at POST `/mcp`, behind the Bearer gate (OAuth access token with the right
 * audience, or a `drk_` API key). One handler serves the 2026-07-28 revision
 * (every request carries its protocol version, client and capabilities in
 * `_meta`) and 2025-era clients (`initialize` is answered by a fresh instance
 * and opens no session). GET and DELETE answer 405.
 *
 * The endpoint keeps nothing between requests. Each one is authenticated from
 * its headers, its body read, and it is served by an MCP server built for its
 * user + scope (`buildMcpServer`), so a revoked credential fails on its next
 * request and a restart is invisible to clients. The tool bodies live in
 * @drobek/mcp (`registerAppTools`). Two independent checks run for every tool:
 *  - SCOPE — `TOOL_SCOPES` (scopes.ts) decides which tools exist for the
 *    grant: only those are registered, so tools/list shows exactly them and
 *    a call to any other tool fails.
 *  - MEMBERSHIP — every tool resolves the caller's role in the target app's
 *    workspace on the call (@drobek/mcp access.ts); an unknown app/workspace
 *    and a non-member answer the same `not_found`.
 *
 * A request is authenticated from its headers before its body is read. A POST
 * body is parsed here, capped at MCP_MAX_BODY_BYTES, and always handed to the
 * SDK parsed (the SDK's own 4 MiB read limit never applies): an oversized one
 * answers 413 with a JSON-RPC error saying how to split the write, malformed
 * JSON a JSON-RPC parse error (-32700). A failure answers JSON-RPC -32603 and
 * goes to the log and the error reporter. Every request leaves one access-log
 * line when its response closes — methods, protocol, status, timing and the
 * user id, never arguments, credentials or bodies.
 *
 * A 2026 client may hold a `subscriptions/listen` stream open (SSE). drobek
 * publishes nothing on it; MCP_MAX_SUBSCRIPTIONS caps how many are open, and
 * the shutdown ends them before it drains the requests in flight.
 */
import { performance } from 'node:perf_hooks';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  createMcpHandler,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  type AuthInfo,
  type CacheHint,
  type McpServerOptions,
} from '@modelcontextprotocol/server';
import express, { type Express, type Request, type Response } from 'express';
import { SERVER_INSTRUCTIONS } from '@drobek/agent-dx';
import { coreVersion, createConsoleLogger, reportError, type Logger } from '@drobek/core';
import { dbErrorForLog } from '@drobek/db';
import { mcpMaxBodyBytes, registerAppTools, type RegisterOptions } from '@drobek/mcp';
import { toolAllowed } from '../scopes.js';
import { registerDocs } from './docs.js';
import { authenticate, send401, type AuthContext } from './oauth-resource.js';

/** The lists change only with a deploy; `private` because they depend on the grant. */
const LIST_CACHE_HINT: CacheHint = { ttlMs: 300_000, cacheScope: 'private' };

const CACHE_HINTS: McpServerOptions['cacheHints'] = {
  'tools/list': LIST_CACHE_HINT,
  'prompts/list': LIST_CACHE_HINT,
  'resources/list': LIST_CACHE_HINT,
  'resources/read': LIST_CACHE_HINT,
};

/** What may drive a lease: the API key, or the OAuth client whose rotating tokens act for the user. */
function grantOf(ctx: AuthContext): string {
  return ctx.kind === 'api_key' ? `api_key:${ctx.credentialId}` : `oauth:${ctx.oauthClientId ?? ''}`;
}

/**
 * Build a fresh MCP server for one authenticated principal + granted scope.
 * `deps` is a test seam (lease store, compiler, clock) passed to @drobek/mcp.
 */
export function buildMcpServer(ctx: AuthContext, deps?: RegisterOptions['deps']): McpServer {
  const server = new McpServer(
    { name: 'drobek', version: coreVersion().version },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: SERVER_INSTRUCTIONS,
      cacheHints: CACHE_HINTS,
    }
  );

  // Docs resources (drobek://docs/*) + the guided prompt, scope-agnostic: a
  // connected agent can read the contract without web access.
  registerDocs(server);

  // Registration gate: a tool exists for this grant iff its scope was granted.
  registerAppTools(
    server,
    { userId: ctx.userId, email: ctx.email, superAdmin: ctx.superAdmin },
    { allow: (tool) => toolAllowed(ctx.scopes, tool), grant: grantOf(ctx), deps }
  );

  return server;
}

/** Open `subscriptions/listen` streams one process holds (SDK default 1024). */
export const MCP_MAX_SUBSCRIPTIONS_DEFAULT = 256;

/** `MCP_MAX_SUBSCRIPTIONS` from the env; a missing or invalid value keeps the default. */
export function mcpMaxSubscriptions(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MCP_MAX_SUBSCRIPTIONS);
  return Number.isInteger(n) && n > 0 ? n : MCP_MAX_SUBSCRIPTIONS_DEFAULT;
}

export interface McpEndpointOptions {
  /** Max bytes of one request body. Default: MCP_MAX_BODY_BYTES (@drobek/mcp `mcpMaxBodyBytes`). */
  maxBodyBytes?: number;
  /** Open `subscriptions/listen` streams. Default: MCP_MAX_SUBSCRIPTIONS. */
  maxSubscriptions?: number;
  /** The access log and the failures. Default: the console logger `mcp`. */
  log?: Logger;
  /** Builds the MCP server of one request. Default: `buildMcpServer`. */
  buildServer?: (ctx: AuthContext) => McpServer;
}

/** The endpoint as the server's shutdown drives it: `stop` before the drain, `close` after it. */
export interface McpEndpoint {
  /**
   * Answer every new request 503 with Retry-After and end the open
   * `subscriptions/listen` streams, so they do not hold the drain open;
   * requests in flight run on.
   */
  stop(): void;
  /** Tear the handler down. Aborts the 2026 requests still in flight, so it runs after the drain. */
  close(): Promise<void>;
}

/** Longest JSON-RPC method, tool name, header value or protocol the access log keeps. */
const LOG_NAME_MAX = 64;
/** Seconds a client is told to wait while the server restarts. */
const RESTART_RETRY_AFTER_SEC = 5;
const AUTH_CONTEXT_KEY = 'drobek.authContext';

interface AccessEntry {
  started: number;
  rpc?: string;
  tool?: string;
  protocol?: string;
  mcpMethod?: string;
  mcpName?: string;
  userId?: string;
}

function logName(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value.slice(0, LOG_NAME_MAX) : undefined;
}

function header(req: Request, name: string): string | undefined {
  return logName(req.headers[name]);
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

/**
 * The revision a request speaks: a 2026 request names it in `_meta` (and the
 * MCP-Protocol-Version header); a 2025 one names its version in the header
 * or in `initialize`, otherwise it is `legacy`.
 */
function protocolOf(req: Request, body: unknown): string {
  const first: unknown = Array.isArray(body) ? body[0] : body;
  const params = first && typeof first === 'object' ? (first as { params?: unknown }).params : undefined;
  if (params && typeof params === 'object') {
    const meta = (params as { _meta?: unknown })._meta;
    const claimed = meta && typeof meta === 'object' ? logName((meta as Record<string, unknown>)[PROTOCOL_VERSION_META_KEY]) : undefined;
    if (claimed) return claimed;
  }
  const fromHeader = header(req, 'mcp-protocol-version');
  if (fromHeader) return fromHeader;
  if ((first as { method?: unknown } | undefined)?.method === 'initialize' && params && typeof params === 'object') {
    const asked = logName((params as { protocolVersion?: unknown }).protocolVersion);
    if (asked) return asked;
  }
  return 'legacy';
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

/** The SDK's pass-through auth: the drobek principal rides in `extra`; the secret itself is never handed on. */
function toAuthInfo(ctx: AuthContext): AuthInfo {
  return { token: '', clientId: grantOf(ctx), scopes: [...ctx.scopes], extra: { [AUTH_CONTEXT_KEY]: ctx } };
}

function authContextOf(authInfo: AuthInfo | undefined): AuthContext {
  const ctx = authInfo?.extra?.[AUTH_CONTEXT_KEY];
  if (!ctx) throw new Error('an MCP server was requested for an unauthenticated request');
  return ctx as AuthContext;
}

/** Mount the Bearer-protected MCP endpoint on the app. */
export function mountMcpEndpoint(app: Express, opts: McpEndpointOptions = {}): McpEndpoint {
  const maxBodyBytes = opts.maxBodyBytes ?? mcpMaxBodyBytes(process.env);
  const log = opts.log ?? createConsoleLogger('mcp');
  const build = opts.buildServer ?? ((ctx: AuthContext) => buildMcpServer(ctx));
  const parseJson = express.json({ limit: maxBodyBytes });
  const listenStreams = new Set<Response>();
  let stopping = false;

  const readBody = (req: Request, res: Response): Promise<unknown> =>
    new Promise((resolve) => parseJson(req, res, (err?: unknown) => resolve(err)));

  function report(err: unknown, method: string): void {
    log.error('mcp request failed', { method, error: dbErrorForLog(err, { stack: true }) });
    void reportError({
      message: 'mcp request failed',
      error: err,
      context: { kind: 'http', method, route: '/mcp', status: 500 },
    });
  }

  const handler = createMcpHandler(
    ({ authInfo }) => {
      try {
        return build(authContextOf(authInfo));
      } catch (err) {
        report(err, 'POST');
        throw err;
      }
    },
    {
      legacy: 'stateless',
      onerror: (err) => log.warn('mcp handler error', { error: dbErrorForLog(err) }),
      maxSubscriptions: opts.maxSubscriptions ?? mcpMaxSubscriptions(process.env),
    }
  );
  const serve = toNodeHandler(handler, { onerror: (err) => report(err, 'POST') });

  async function handle(req: Request, res: Response, entry: AccessEntry): Promise<void> {
    if (stopping) {
      res.setHeader('Retry-After', String(RESTART_RETRY_AFTER_SEC));
      jsonRpcError(res, 503, -32000, 'The server is restarting: retry in a few seconds.');
      return;
    }

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

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      jsonRpcError(res, 405, -32000, 'Method not allowed.');
      return;
    }

    const bodyError = await readBody(req, res);
    if (bodyError) {
      const answer = bodyErrorAnswer(bodyError, maxBodyBytes);
      if (!answer) throw bodyError;
      jsonRpcError(res, answer.status, answer.code, answer.message);
      return;
    }
    Object.assign(entry, rpcSummary(req.body));
    entry.protocol = protocolOf(req, req.body);
    entry.mcpMethod = header(req, 'mcp-method');
    entry.mcpName = header(req, 'mcp-name');

    if (entry.rpc === 'subscriptions/listen') {
      listenStreams.add(res);
      // `stop` ends the stream under the SDK, whose keep-alive frame may race that end.
      res.on('error', () => {});
      res.once('close', () => listenStreams.delete(res));
    }
    (req as Request & { auth?: AuthInfo }).auth = toAuthInfo(ctx);
    await serve(req, res, req.body);
  }

  function fail(req: Request, res: Response, err: unknown): void {
    report(err, req.method);
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
        ...(entry.protocol ? { protocol: entry.protocol } : {}),
        ...(entry.mcpMethod ? { mcp_method: entry.mcpMethod } : {}),
        ...(entry.mcpName ? { mcp_name: entry.mcpName } : {}),
        ...(entry.userId ? { user_id: entry.userId } : {}),
        ...(res.writableFinished ? {} : { aborted: true }),
      });
    });
    handle(req, res, entry).catch((err: unknown) => fail(req, res, err));
  };
  app.post('/mcp', route);
  app.get('/mcp', route);
  app.delete('/mcp', route);

  return {
    stop() {
      stopping = true;
      for (const res of listenStreams) res.end();
      listenStreams.clear();
    },
    close: () => handler.close(),
  };
}
