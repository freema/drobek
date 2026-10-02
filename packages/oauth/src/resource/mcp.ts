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
 *    scope, grant) it was opened with.
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
 * Sessions live in this process only and are bound to the user, scope and
 * grant (the API key, or the OAuth client whose rotating tokens drive it) they
 * were opened with. One is closed when it had no request open for
 * MCP_SESSION_IDLE_TTL_MS, when its user opens one past MCP_SESSIONS_PER_USER
 * (the least recently used goes), when its credential is revoked in this
 * process, and on a restart. A request with a closed session's id answers 404,
 * after which the client initializes a new session (MCP Streamable HTTP).
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
import { onCredentialsRevoked } from '../revocations.js';
import { toolAllowed } from '../scopes.js';
import { registerDocs } from './docs.js';
import {
  authenticate,
  liveCredentials,
  send401,
  type AuthContext,
  type CredentialRef,
} from './oauth-resource.js';
import { mcpSessionLimits, type McpSessionLimits } from './session-limits.js';

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
  id: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  /** The session is pinned to the principal + scope its tools were built for. */
  userId: string;
  scope: string;
  /** What may drive it: the same API key, or a token of the same OAuth client (its tokens rotate). */
  grant: string;
  /** The credential of its latest request — what a revocation is checked against. */
  credential: CredentialRef;
  /** When a request on it last started or ended. */
  lastActive: number;
  /** Its requests still open; a GET listen stream counts while the client listens. */
  inFlight: number;
}

type CloseReason = 'idle' | 'limit' | 'revoked';

function grantOf(ctx: AuthContext): string {
  return ctx.kind === 'api_key' ? `api_key:${ctx.credentialId}` : `oauth:${ctx.oauthClientId ?? ''}`;
}

/** The idle sweep runs once per idle TTL, at least every minute and at most every second. */
function sweepIntervalFor(idleTtlMs: number): number {
  return Math.min(60_000, Math.max(1_000, idleTtlMs));
}

export interface McpEndpointOptions {
  /** Max bytes of one request body. Default: MCP_MAX_BODY_BYTES (@drobek/mcp `mcpMaxBodyBytes`). */
  maxBodyBytes?: number;
  /** The access log and the failures. Default: the console logger `mcp`. */
  log?: Logger;
  /** Builds the MCP server of a new session. Default: `buildMcpServer`. */
  buildServer?: (ctx: AuthContext) => McpServer;
  /** The idle TTL and the per-user cap. Default: MCP_SESSION_IDLE_TTL_MS / MCP_SESSIONS_PER_USER. */
  sessionLimits?: McpSessionLimits;
  /** How often idle sessions are closed. Default: the idle TTL, at least every minute, at most every second. */
  sweepIntervalMs?: number;
  /** The clock of the idle TTL. Default: `Date.now`. */
  now?: () => number;
}

/** The open MCP sessions of this process, as the server's shutdown needs them. */
export interface McpEndpoint {
  /**
   * End every session's GET listen stream (SSE) and answer later GETs 405,
   * so a draining server is not held open by them; requests in flight run on.
   */
  endListenStreams(): void;
  /** Close every session idle for the idle TTL (the endpoint also does it on a timer); returns how many. */
  closeIdleSessions(): number;
  /**
   * Close every session and stop the idle sweep and the revocation listener
   * (the server's shutdown); a later request with a session's id answers 404
   * and the client re-initializes.
   */
  closeSessions(): Promise<void>;
  /** How many sessions are open. */
  sessionCount(): number;
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
export function mountMcpEndpoint(app: Express, opts: McpEndpointOptions = {}): McpEndpoint {
  const sessions = new Map<string, McpSession>();
  const maxBodyBytes = opts.maxBodyBytes ?? mcpMaxBodyBytes(process.env);
  const log = opts.log ?? createConsoleLogger('mcp');
  const build = opts.buildServer ?? ((ctx: AuthContext) => buildMcpServer(ctx));
  const limits = opts.sessionLimits ?? mcpSessionLimits(process.env);
  const now = opts.now ?? Date.now;
  const parseJson = express.json({ limit: maxBodyBytes });
  let listenStreams = true;

  const readBody = (req: Request, res: Response): Promise<unknown> =>
    new Promise((resolve) => parseJson(req, res, (err?: unknown) => resolve(err)));

  const isIdle = (session: McpSession, at: number): boolean =>
    session.inFlight === 0 && at - session.lastActive >= limits.idleTtlMs;

  function closeSession(session: McpSession, reason: CloseReason): void {
    if (sessions.get(session.id) !== session) return;
    sessions.delete(session.id);
    log.info('mcp session closed', {
      reason,
      session: session.id.slice(0, LOG_SESSION_CHARS),
      user_id: session.userId,
    });
    session.server.close().catch((err: unknown) => {
      log.warn('mcp session close failed', { error: dbErrorForLog(err) });
    });
  }

  /** A request on `session` starts: note its credential and keep the session active until the response closes. */
  function track(session: McpSession, ctx: AuthContext, res: Response): void {
    session.credential = { kind: ctx.kind, id: ctx.credentialId };
    session.inFlight += 1;
    session.lastActive = now();
    res.once('close', () => {
      session.inFlight -= 1;
      session.lastActive = now();
    });
  }

  /** Past the per-user cap, close the user's least recently used sessions, never `keep`. */
  function enforcePerUserCap(userId: string, keep: string): void {
    const own = [...sessions.values()].filter((s) => s.userId === userId);
    const excess = own.length - limits.perUser;
    if (excess <= 0) return;
    const others = own.filter((s) => s.id !== keep).sort((a, b) => a.lastActive - b.lastActive);
    for (const s of others.slice(0, excess)) closeSession(s, 'limit');
  }

  function closeIdleSessions(): number {
    const at = now();
    let closed = 0;
    for (const session of [...sessions.values()]) {
      if (!isIdle(session, at)) continue;
      closeSession(session, 'idle');
      closed += 1;
    }
    return closed;
  }

  /** Close the sessions of `userId` whose latest credential is no longer live. */
  async function closeRevokedSessions(userId: string): Promise<void> {
    const checked = [...sessions.values()]
      .filter((s) => s.userId === userId)
      .map((s) => ({ session: s, credential: s.credential }));
    if (checked.length === 0) return;
    const isLive = await liveCredentials(checked.map((c) => c.credential));
    for (const { session, credential } of checked) {
      const current = session.credential;
      if (current.kind !== credential.kind || current.id !== credential.id) continue;
      if (!isLive(credential)) closeSession(session, 'revoked');
    }
  }

  const sweep = setInterval(closeIdleSessions, opts.sweepIntervalMs ?? sweepIntervalFor(limits.idleTtlMs));
  sweep.unref();
  const stopRevocations = onCredentialsRevoked((userId) => {
    closeRevokedSessions(userId).catch((err: unknown) => {
      log.warn('mcp session revocation check failed', { user_id: userId, error: dbErrorForLog(err) });
    });
  });

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

    if (req.method === 'GET' && !listenStreams) {
      res.setHeader('Allow', 'POST, DELETE');
      jsonRpcError(res, 405, -32000, 'The server is restarting: no listen stream now.');
      return;
    }

    let session = sessionId ? sessions.get(sessionId) : undefined;
    if (session && isIdle(session, now())) {
      closeSession(session, 'idle');
      session = undefined;
    }
    if (session) {
      // A session may only be driven by the user, scope AND grant it was
      // opened for — its tool set was registered for that scope.
      if (session.userId !== ctx.userId || session.scope !== ctx.scope || session.grant !== grantOf(ctx)) {
        send401(res, 'invalid_token', 'Token does not match this MCP session.');
        return;
      }
      track(session, ctx, res);
      await session.transport.handleRequest(req, res, req.body);
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
          const opened: McpSession = {
            id,
            transport,
            server,
            userId: ctx.userId,
            scope: ctx.scope,
            grant: grantOf(ctx),
            credential: { kind: ctx.kind, id: ctx.credentialId },
            lastActive: now(),
            inFlight: 0,
          };
          sessions.set(id, opened);
          track(opened, ctx, res);
          entry.session = id.slice(0, LOG_SESSION_CHARS);
          enforcePerUserCap(ctx.userId, id);
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

  return {
    endListenStreams() {
      listenStreams = false;
      for (const s of sessions.values()) s.transport.closeStandaloneSSEStream();
    },
    closeIdleSessions,
    async closeSessions() {
      clearInterval(sweep);
      stopRevocations();
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(open.map((s) => s.server.close()));
    },
    sessionCount: () => sessions.size,
  };
}
