/**
 * POST /oauth/register (U5, M0-04) — Dynamic Client Registration (RFC 7591)
 * for public PKCE clients. Kept next to CIMD because Claude and ChatGPT
 * register this way today. Accepts client_name + redirect_uris[]; validates
 * each URI is absolute https (or http on loopback for native/dev clients);
 * returns a client_id with token_endpoint_auth_method = "none". no-store.
 *
 * Abuse caps (PHY-76 #7): 10 registrations per client IP per hour (→ 429),
 * capped client_name / redirect_uris, and at most OAUTH_DCR_MAX_UNUSED_CLIENTS
 * (default 500) clients that never received a grant (→ 503) — abandoned
 * registrations older than a day are pruned first.
 */
import type { ActionFunctionArgs } from 'react-router';
import { getClientIp, rateLimitRedis } from '@drobek/auth';
import {
  countUnusedDcrClients,
  createClient,
  pruneUnusedDcrClients,
} from '../clients.server.js';
import {
  DCR_MAX_UNUSED_CLIENTS,
  DCR_RATE_LIMIT,
  DCR_RATE_WINDOW_MS,
  DCR_UNUSED_CLIENT_TTL_MS,
} from '../constants.js';
import { checkClientMetadata } from '../redirect-uri.js';

type RegisterBody = {
  client_name?: unknown;
  redirect_uris?: unknown;
};

function jsonError(
  error: string,
  description: string,
  status = 400,
  headers: Record<string, string> = {}
): Response {
  return Response.json(
    { error, error_description: description },
    { status, headers: { 'Cache-Control': 'no-store', ...headers } }
  );
}

/** OAUTH_DCR_MAX_UNUSED_CLIENTS (positive integer) or the 500 default. */
export function maxUnusedDcrClients(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.OAUTH_DCR_MAX_UNUSED_CLIENTS);
  return Number.isInteger(n) && n > 0 ? n : DCR_MAX_UNUSED_CLIENTS;
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return jsonError('invalid_request', 'POST required', 405);
  }

  // Per-IP fixed window, counted before any parsing so junk bodies pay too.
  const ip = getClientIp(request) ?? 'unknown';
  const limited = await rateLimitRedis(
    'oauth-register-ip',
    ip,
    DCR_RATE_LIMIT,
    DCR_RATE_WINDOW_MS
  );
  if (!limited.ok) {
    return jsonError(
      'rate_limited',
      `at most ${DCR_RATE_LIMIT} client registrations per hour from one address`,
      429,
      { 'Retry-After': String(Math.ceil(DCR_RATE_WINDOW_MS / 1000)) }
    );
  }

  let body: RegisterBody;
  try {
    body = (await request.json()) as RegisterBody;
  } catch {
    return jsonError('invalid_client_metadata', 'JSON body required');
  }

  const meta = checkClientMetadata({
    clientName: body.client_name,
    redirectUris: body.redirect_uris,
  });
  if (!meta.ok) return jsonError(meta.error, meta.description);

  if ((await countUnusedDcrClients()) >= maxUnusedDcrClients()) {
    await pruneUnusedDcrClients(new Date(Date.now() - DCR_UNUSED_CLIENT_TTL_MS));
    if ((await countUnusedDcrClients()) >= maxUnusedDcrClients()) {
      return jsonError(
        'temporarily_unavailable',
        'too many unused client registrations — try again later',
        503,
        { 'Retry-After': '3600' }
      );
    }
  }

  const client = await createClient({
    clientName: meta.clientName,
    redirectUris: meta.redirectUris,
  });

  return Response.json(
    {
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
    { status: 201, headers: { 'Cache-Control': 'no-store' } }
  );
}
