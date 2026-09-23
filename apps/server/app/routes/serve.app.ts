/**
 * U7 (PHY-58) — hardened same-origin app serving: `GET /:ws/app/:slug/*` (and
 * the bare `/:ws/app/:slug` → index.html), plus `POST /:ws/app/:slug` for the
 * password gate. A resource route (no component) that returns the raw web
 * `Response` from the react-free `@drobek/serving` core, so the saas web app
 * mirrors it with an identical thin file.
 *
 * SECURITY: `serveApp` runs the visibility gate BEFORE any blob access and
 * never sets `drobek_session` on these paths. The residual same-origin
 * exposure of the (Path=/) dashboard session is deferred to PHY-98 / U11 — see
 * the header comment in @drobek/serving/serve.server.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import {
  handleAppPasswordPost,
  serveApp,
  type ServeParams,
} from '@drobek/serving';

function paramsOf(params: Record<string, string | undefined>): ServeParams {
  return {
    wsSlug: params.ws ?? '',
    appSlug: params.slug ?? '',
    splat: params['*'] ?? '',
  };
}

export async function loader({
  request,
  params,
}: LoaderFunctionArgs): Promise<Response> {
  return serveApp(request, paramsOf(params));
}

export async function action({
  request,
  params,
}: ActionFunctionArgs): Promise<Response> {
  return handleAppPasswordPost(request, paramsOf(params));
}
