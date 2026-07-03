/**
 * POST /oauth/register (U5) — Dynamic Client Registration (RFC 7591) for public
 * PKCE clients. Accepts client_name + redirect_uris[]; validates each URI is
 * absolute https (or http on loopback for native/dev clients); returns a
 * client_id with token_endpoint_auth_method = "none". no-store.
 */
import type { ActionFunctionArgs } from 'react-router';
import { createClient } from '../clients.server.js';
import { isValidRegisterRedirectUri } from '../redirect-uri.js';

type RegisterBody = {
  client_name?: unknown;
  redirect_uris?: unknown;
};

function jsonError(error: string, description: string, status = 400): Response {
  return Response.json(
    { error, error_description: description },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length > 0);
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return jsonError('invalid_request', 'POST required', 405);
  }

  let body: RegisterBody;
  try {
    body = (await request.json()) as RegisterBody;
  } catch {
    return jsonError('invalid_client_metadata', 'JSON body required');
  }

  const clientName =
    typeof body.client_name === 'string' ? body.client_name.trim() : '';
  if (!clientName) {
    return jsonError('invalid_client_metadata', 'client_name is required');
  }

  if (!isStringArray(body.redirect_uris) || body.redirect_uris.length === 0) {
    return jsonError(
      'invalid_redirect_uri',
      'redirect_uris must be a non-empty array of strings'
    );
  }
  for (const uri of body.redirect_uris) {
    if (!isValidRegisterRedirectUri(uri)) {
      return jsonError(
        'invalid_redirect_uri',
        `redirect_uri "${uri}" must be absolute https (or http on localhost)`
      );
    }
  }

  const client = await createClient({
    clientName,
    redirectUris: body.redirect_uris,
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
