/**
 * PHY-123 — the PUBLIC error beacon: `POST /:ws/app/:slug/__beacon`. A thin
 * resource route (no component) that returns the raw web `Response` from the
 * react-free `@drobek/insights/beacon` core, which owns the whole security
 * contract: an 8 KB hard cap enforced BEFORE parsing, a per-app+IP rate-limit,
 * PII/secret sanitization, ring-buffer retention, and rejection of beacons for
 * unknown/deleted apps. Returns 204 fast + no-store. Mirrored by the saas web
 * app with an identical thin file.
 *
 * The literal `__beacon` suffix keeps this specific — it never shadows the U7
 * serve splat (`:ws/app/:slug/*`) nor the U10 data routes.
 */
import type { ActionFunctionArgs } from 'react-router';
import { handleBeacon, type BeaconParams } from '@drobek/insights/beacon';

function paramsOf(params: Record<string, string | undefined>): BeaconParams {
  return {
    wsSlug: params.ws ?? '',
    appSlug: params.slug ?? '',
  };
}

export async function loader(): Promise<Response> {
  // GET is not a beacon verb — 405 (no-store).
  return new Response(null, {
    status: 405,
    headers: { 'Cache-Control': 'no-store', Allow: 'POST' },
  });
}

export async function action({
  request,
  params,
}: ActionFunctionArgs): Promise<Response> {
  return handleBeacon(request, paramsOf(params));
}
