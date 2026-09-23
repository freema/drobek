/**
 * U10 (PHY-55/PHY-56) — REST data collection endpoint:
 *   GET  /:ws/app/:slug/data/:collection   → list/query documents
 *   POST /:ws/app/:slug/data/:collection   → create a document
 *
 * A resource route (no component) that returns the raw web `Response` from the
 * react-free `@drobek/data/rest` core. Access is enforced by the collection's
 * access_mode against the resolved caller (anon vs workspace session member);
 * rate-limit + quota + schema validation apply to every mode. Same-origin only
 * for U10 (the cross-origin apps-origin is U11). Mirrored by the saas web app.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { handleDataCollection, type DataRestParams } from '@drobek/data/rest';

function paramsOf(params: Record<string, string | undefined>): DataRestParams {
  return {
    wsSlug: params.ws ?? '',
    appSlug: params.slug ?? '',
    collection: params.collection ?? '',
  };
}

export async function loader({
  request,
  params,
}: LoaderFunctionArgs): Promise<Response> {
  return handleDataCollection(request, paramsOf(params));
}

export async function action({
  request,
  params,
}: ActionFunctionArgs): Promise<Response> {
  return handleDataCollection(request, paramsOf(params));
}
