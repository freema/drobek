/**
 * The proxy module's `upstreams` authority (contract 1.2): a module
 * JOB's `ctx.upstreams.fetch(name, { method, path })` — e.g. the `sync`
 * module's scheduled import. There is no caller, so no call rule and no
 * per-caller rate limit; everything that protects the upstream and the
 * secret still applies: the assignment in this app's proxy config, the
 * registered + bound + admin-confirmed record (resolve.ts), a slot among the
 * calls in flight, and `forwardToUpstream` (method + path allow-lists, the
 * secret injected server-side, SSRF guard, the response deadline, the size cap — the lower of
 * PROXY_MAX_RESPONSE_BYTES and the job's own).
 */
import { ModuleError, type OwnerView, type UpstreamRequest, type UpstreamResponse, type UpstreamsAuthority } from '@drobek/modules';
import { ProxyError, acquireProxySlot, forwardToUpstream } from '@drobek/proxy';
import { assignmentOf, type ProxyConfig } from './config.js';
import { assignedUpstream, notAssigned } from './resolve.js';
import { toModuleError, type ProxyRouteOptions } from './routes.js';

/** `/v1/players?season=2026` → the subpath below the base URL and the raw query. */
function splitPath(path: string | undefined): { subpath: string; search: string } {
  const raw = path && path.length > 0 ? path : '/';
  const q = raw.indexOf('?');
  const pathPart = q === -1 ? raw : raw.slice(0, q);
  return { subpath: pathPart.replace(/^\/+/, ''), search: q === -1 ? '' : raw.slice(q) };
}

export function upstreamsAuthority(opts: ProxyRouteOptions = {}): UpstreamsAuthority<ProxyConfig> {
  return {
    async fetch(view: OwnerView<ProxyConfig>, name: string, request: UpstreamRequest): Promise<UpstreamResponse> {
      const assignment = assignmentOf(view.config, name);
      if (!assignment) throw notAssigned(name);
      const method = (request.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'POST') {
        throw new ModuleError('invalid_request', `A job calls an upstream with GET or POST, not ${method}.`);
      }
      const env = opts.env?.() ?? process.env;
      const headers = new Headers({ accept: 'application/json' });
      for (const [k, v] of Object.entries(request.headers ?? {})) {
        try {
          headers.set(k, v);
        } catch {
          /* an unrepresentable header never reaches the upstream */
        }
      }
      const body = method === 'POST' && request.body !== undefined ? Buffer.from(request.body, 'utf8') : undefined;
      if (body && !headers.has('content-type')) headers.set('content-type', 'application/json');
      const { subpath, search } = splitPath(request.path);
      let release: (() => void) | undefined;
      const started = Date.now();
      try {
        release = acquireProxySlot(view.app.id, env);
        const upstream = await assignedUpstream({ db: view.db, log: view.log, app: view.app, name, assignment });
        const result = await forwardToUpstream({ upstream, method, subpath, search, headers, body, env, maxResponseBytes: request.maxBytes });
        view.log.info('proxy job call', { app_id: view.app.id, upstream: name, method, status: result.status, ms: Date.now() - started });
        return { status: result.status, headers: result.headers, body: result.body ?? Buffer.alloc(0) };
      } catch (err) {
        if (err instanceof ProxyError) {
          view.log.info('proxy job call refused', { app_id: view.app.id, upstream: name, method, error: err.code });
          throw toModuleError(err);
        }
        throw err;
      } finally {
        release?.();
      }
    },
  };
}
