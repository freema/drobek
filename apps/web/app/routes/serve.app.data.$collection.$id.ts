/**
 * U10 (PHY-55/PHY-56) — REST data document endpoint:
 *   GET    /:ws/app/:slug/data/:collection/:id  → read a document
 *   PATCH  /:ws/app/:slug/data/:collection/:id  → shallow-merge update
 *   DELETE /:ws/app/:slug/data/:collection/:id  → soft-delete
 *
 * Thin resource route → the react-free `@drobek/data/rest` core (same access /
 * rate-limit / quota / validation guarantees as the collection endpoint).
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { handleDataDocument, type DataRestParams } from '@drobek/data/rest';

function paramsOf(params: Record<string, string | undefined>): DataRestParams {
  return {
    wsSlug: params.ws ?? '',
    appSlug: params.slug ?? '',
    collection: params.collection ?? '',
    id: params.id ?? '',
  };
}

export async function loader({
  request,
  params,
}: LoaderFunctionArgs): Promise<Response> {
  return handleDataDocument(request, paramsOf(params));
}

export async function action({
  request,
  params,
}: ActionFunctionArgs): Promise<Response> {
  return handleDataDocument(request, paramsOf(params));
}
