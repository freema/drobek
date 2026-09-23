/**
 * ModuleRouter (M1-01): the route table of one module and the request
 * pipeline every module route goes through, in this order —
 *
 *   1. match method + path (404 / 405);
 *   2. CSRF guard for mutations: an `Origin`, when present, must be the app
 *      host itself (`null` and foreign origins → 403); with the default
 *      `csrf: 'sdk-header'` also `X-Drobek-SDK: 1`;
 *   3. the caller (principal) and this app's config → the route `rule`
 *      (401 / 403);
 *   4. rate limit (429 `rate_limited`, Retry-After);
 *   5. body: JSON (or, when the route accepts it, text-only
 *      multipart/form-data), size-capped, then the route's zod schema; query
 *      too (400 `invalid_request` with `details: [{ path, message }]`);
 *   6. the handler → JSON (or `respond(...)`), `Cache-Control: no-store`.
 *
 * Every failure answers the uniform `{ error, message, details?, hint }`.
 */
import type { ZodType } from 'zod';
import type {
  ModuleContext,
  ModuleResponse,
  ModuleRouter,
  Principal,
  RouteHandler,
  RouteOptions,
} from './contract.js';
import { ModuleError, isModuleError, issuePaths } from './errors.js';
import { parseMultipart } from './multipart.js';
import { decideAccess } from './rules.js';

export const DEFAULT_MAX_BODY_BYTES = 32 * 1024;
export const SDK_HEADER = 'x-drobek-sdk';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface Route {
  method: Method;
  pattern: string;
  segments: string[];
  opts: RouteOptions<unknown, unknown, unknown>;
  handler: RouteHandler<unknown, unknown, unknown>;
}

function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

export function normalizePattern(pattern: string): string {
  const segs = splitPath(pattern);
  for (const s of segs) {
    if (s.startsWith(':') ? !/^:[A-Za-z_][A-Za-z0-9_]*$/.test(s) : !/^[A-Za-z0-9._~-]+$/.test(s)) {
      throw new Error(`invalid route segment "${s}" in "${pattern}"`);
    }
  }
  return '/' + segs.join('/');
}

/** Build a module's route table by running its `routes(r)`. */
export function collectRoutes(register: ((r: ModuleRouter) => void) | undefined): Route[] {
  const routes: Route[] = [];
  const add = (method: Method) => (path: string, a: unknown, b?: unknown) => {
    const [opts, handler] = (typeof a === 'function' ? [{}, a] : [a ?? {}, b]) as [
      RouteOptions<unknown, unknown, unknown>,
      RouteHandler<unknown, unknown, unknown>,
    ];
    if (typeof handler !== 'function') throw new Error(`route ${method} ${path} has no handler`);
    const pattern = normalizePattern(path);
    if (routes.some((r) => r.method === method && r.pattern === pattern)) {
      throw new Error(`route ${method} ${pattern} is registered twice`);
    }
    routes.push({ method, pattern, segments: splitPath(pattern), opts, handler });
  };
  const r = { get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') };
  register?.(r as unknown as ModuleRouter);
  return routes;
}

function matchSegments(segments: string[], parts: string[]): Record<string, string> | null {
  if (segments.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s.startsWith(':')) {
      let v: string;
      try {
        v = decodeURIComponent(parts[i]);
      } catch {
        return null;
      }
      if (v.length === 0 || v.includes('/')) return null;
      params[s.slice(1)] = v;
    } else if (s !== parts[i]) {
      return null;
    }
  }
  return params;
}

export type RouteMatch =
  | { kind: 'route'; route: Route; params: Record<string, string> }
  | { kind: 'method_not_allowed'; allow: string[] }
  | { kind: 'not_found' };

export function matchRoute(routes: Route[], method: string, path: string): RouteMatch {
  const parts = splitPath(path);
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  const allow = new Set<string>();
  for (const route of routes) {
    const params = matchSegments(route.segments, parts);
    if (!params) continue;
    if (route.method === m) return { kind: 'route', route, params };
    allow.add(route.method);
  }
  return allow.size > 0 ? { kind: 'method_not_allowed', allow: [...allow] } : { kind: 'not_found' };
}

// ── the pipeline ─────────────────────────────────────────────────────────────

/** What the pipeline needs from the HTTP request (framework-free). */
export interface PipelineRequest {
  method: string;
  path: string;
  query: string;
  header(name: string): string | null;
  clientIp: string | null;
  /** The raw body up to `limit` bytes; 'too_large' past it. */
  readBody(limit: number): Promise<Buffer | 'too_large' | null>;
}

export interface PipelineResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string | null;
}

/** The pipeline's seams: the runtime builds the context (config, principal, services). */
export interface PipelineDeps {
  module: string;
  /** The app host's own origin (`http(s)://<host>`), for the Origin check. */
  selfOrigin: string | null;
  principal(): Promise<Principal>;
  context(principal: Principal): Promise<ModuleContext<unknown>>;
  /** Resolve a limit name to its value for this app's workspace. */
  limit(name: string): Promise<number>;
}

function isResponse(v: unknown): v is ModuleResponse {
  return typeof v === 'object' && v !== null && (v as ModuleResponse).__drobekResponse === true;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): PipelineResult {
  return {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
    body: JSON.stringify(body),
  };
}

/** A ModuleError → the uniform JSON answer. */
export function errorResult(err: ModuleError, module?: string): PipelineResult {
  return json(err.status, err.body(module ? `skill_info('${module}')` : 'skill_info()'), err.headers);
}

/** Enforce the CSRF guard for one request (throws ModuleError). */
export function checkCsrf(req: PipelineRequest, mode: 'sdk-header' | 'same-origin', selfOrigin: string | null): void {
  if (!MUTATING.has(req.method.toUpperCase())) return;
  const origin = req.header('origin')?.trim();
  if (origin) {
    if (origin === 'null' || !selfOrigin || origin.toLowerCase() !== selfOrigin.toLowerCase()) {
      throw new ModuleError('csrf_rejected', 'Cross-origin request refused: module calls must come from the app itself.');
    }
  } else {
    const site = req.header('sec-fetch-site')?.trim().toLowerCase();
    if (site === 'cross-site' || site === 'same-site') {
      throw new ModuleError('csrf_rejected', 'Cross-site request refused: module calls must come from the app itself.');
    }
  }
  if (mode === 'sdk-header' && req.header(SDK_HEADER)?.trim() !== '1') {
    throw new ModuleError(
      'csrf_rejected',
      'Missing the X-Drobek-SDK: 1 header — call module routes through the drobek SDK (import { drobek } from "drobek").'
    );
  }
}

function parseQuery(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) if (!(k in out)) out[k] = v;
  return out;
}

function validate<T>(schema: ZodType<T> | undefined, value: unknown, what: string): T {
  if (!schema) return value as T;
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new ModuleError('invalid_request', `The ${what} is invalid.`, { details: issuePaths(r.error.issues) });
  }
  return r.data;
}

async function readRequestBody(req: PipelineRequest, limit: number, types: ReadonlyArray<'json' | 'multipart'>): Promise<unknown> {
  const raw = await req.readBody(limit);
  if (raw === 'too_large') throw new ModuleError('payload_too_large', `The request body exceeds ${limit} bytes.`);
  if (raw === null || raw.length === 0) return undefined;
  const header = req.header('content-type');
  const type = (header ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'multipart/form-data' && types.includes('multipart')) return parseMultipart(raw, header);
  if (type !== 'application/json' || !types.includes('json')) {
    throw new ModuleError(
      'unsupported_media_type',
      types.includes('multipart')
        ? 'Send the body as JSON (Content-Type: application/json) or multipart/form-data with text fields.'
        : 'Send the body as JSON (Content-Type: application/json).'
    );
  }
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ModuleError('invalid_request', 'The request body is not valid JSON.');
  }
}

function rateKey(per: 'ip' | 'app' | 'principal', req: PipelineRequest, principal: Principal): string {
  if (per === 'app') return 'app';
  if (per === 'principal') return principal.kind === 'user' ? `u:${principal.id}` : `ip:${req.clientIp ?? 'unknown'}`;
  return `ip:${req.clientIp ?? 'unknown'}`;
}

/** Run one matched route through the pipeline (never throws). */
export async function runRoute(
  req: PipelineRequest,
  route: Route,
  params: Record<string, string>,
  deps: PipelineDeps
): Promise<PipelineResult> {
  try {
    const opts = route.opts;
    checkCsrf(req, opts.csrf ?? 'sdk-header', deps.selfOrigin);

    const principal = await deps.principal();
    const ctx = await deps.context(principal);

    if (opts.rule !== undefined) {
      const rule = typeof opts.rule === 'function' ? opts.rule(ctx.config) : opts.rule;
      const d = decideAccess(rule, principal);
      if (!d.ok) {
        throw d.status === 401
          ? new ModuleError('unauthorized', 'Sign in to this app first.')
          : new ModuleError('forbidden', 'You are not allowed to do that in this app.');
      }
    }

    if (opts.rateLimit) {
      const rl = opts.rateLimit;
      const max = typeof rl.max === 'number' ? rl.max : await deps.limit(rl.max);
      const r = await ctx.rateLimit(rl.bucket, rateKey(rl.per ?? 'ip', req, principal), max, rl.windowMs);
      if (!r.ok) {
        throw new ModuleError('rate_limited', `Too many requests — at most ${max} per ${Math.round(rl.windowMs / 1000)} s.`, {
          details: { limit: max, window_seconds: Math.round(rl.windowMs / 1000) },
          headers: { 'Retry-After': String(r.retryAfterSec) },
        });
      }
    }

    const method = req.method.toUpperCase();
    const body =
      method === 'GET' || method === 'HEAD'
        ? undefined
        : validate(
            opts.body,
            await readRequestBody(req, opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES, opts.bodyTypes ?? ['json']),
            'request body'
          );
    const query = validate(opts.query, parseQuery(req.query), 'query');

    const out = await route.handler(
      { method, path: req.path, params, query, body, header: (n) => req.header(n), clientIp: req.clientIp },
      ctx
    );
    if (isResponse(out)) {
      const b = out.body;
      if (typeof b === 'string' || Buffer.isBuffer(b)) {
        return { status: out.status, headers: { 'Cache-Control': 'no-store', ...out.headers }, body: b };
      }
      if (out.status === 204 || b === null || b === undefined) {
        return { status: out.status, headers: { 'Cache-Control': 'no-store', ...out.headers }, body: null };
      }
      return json(out.status, b, out.headers);
    }
    return json(200, out === undefined ? null : out);
  } catch (err) {
    if (isModuleError(err)) return errorResult(err, deps.module);
    throw err;
  }
}
