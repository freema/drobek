/**
 * The proxy route entry (PHY-59) — react-free: takes a web `Request` + route
 * params, returns a web `Response`. apps/web (and the saas web app) mirror this
 * with a thin `ANY /:ws/api/proxy/:name/*` resource route.
 *
 * v1 CALLER AUTH: requireSessionUser + workspace membership (any member) — an
 * anonymous caller gets 401. Everything else (method/path allow-lists, secret
 * injection, rate-limit, SSRF guard, CORS) is enforced by forwardProxy.
 */
import { getSessionUser, isSuperAdmin } from '@drobek/auth';
import { getMembership, getWorkspaceBySlug, type WorkspaceRole } from '@drobek/tenancy';
import { canCallProxy } from './authz.js';
import { ProxyError, proxyErrorStatus, type ProxyErrorCode } from './errors.js';
import { forwardProxy } from './forward.server.js';

export interface ProxyRouteParams {
  ws: string;
  name: string;
  splat: string;
}

function jsonError(status: number, code: ProxyErrorCode | string, message: string): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export function proxyParamsOf(
  params: Record<string, string | undefined>
): ProxyRouteParams {
  return {
    ws: params.ws ?? '',
    name: params.name ?? '',
    splat: params['*'] ?? '',
  };
}

export async function handleProxyRequest(
  request: Request,
  params: ProxyRouteParams
): Promise<Response> {
  try {
    // 1) v1 caller auth: an authenticated session is REQUIRED (401 for anon —
    //    a JSON 401 rather than an HTML /login redirect since this is an API).
    const user = await getSessionUser(request);
    if (!user) {
      return jsonError(401, 'unauthorized', 'authentication is required');
    }

    // 2) Resolve the workspace + the caller's role in it.
    if (!params.ws || !params.name) {
      return jsonError(404, 'not_found', 'upstream not found');
    }
    const workspace = await getWorkspaceBySlug(params.ws);
    if (!workspace) {
      return jsonError(404, 'not_found', 'upstream not found');
    }
    const superAdmin = isSuperAdmin(user.email);
    const membership = await getMembership(user.id, workspace.id);
    const role: WorkspaceRole | null = membership?.role ?? null;

    // 3) v1: ANY workspace member (or super-admin) may call the proxy.
    if (!canCallProxy(role, superAdmin)) {
      return jsonError(403, 'forbidden', 'you are not a member of this workspace');
    }

    // 4) Forward.
    return await forwardProxy({
      workspaceId: workspace.id,
      userId: user.id,
      name: params.name,
      subpath: params.splat,
      request,
    });
  } catch (err) {
    if (err instanceof ProxyError) {
      return jsonError(proxyErrorStatus(err.code), err.code, err.message);
    }
    throw err;
  }
}
