/**
 * PHY-59 — the BFF proxy route: ANY `/:ws/api/proxy/:name/*`.
 *
 * v1 caller-auth = a drobek session + workspace membership (any member); an
 * anonymous caller gets 401. A resource route (no component) that returns the raw
 * web `Response` from the react-free `@drobek/proxy/route` core, so the saas web
 * app mirrors it with an identical thin file. Everything security-critical
 * (method/path allow-lists, secret injection, SSRF guard, rate-limit, CORS) is
 * enforced inside handleProxyRequest → forwardProxy.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { handleProxyRequest, proxyParamsOf } from '@drobek/proxy/route';

export async function loader({
  request,
  params,
}: LoaderFunctionArgs): Promise<Response> {
  return handleProxyRequest(request, proxyParamsOf(params));
}

export async function action({
  request,
  params,
}: ActionFunctionArgs): Promise<Response> {
  return handleProxyRequest(request, proxyParamsOf(params));
}
