/**
 * POST /oauth/token (U5). Two grants:
 *
 *  - authorization_code: verify the code (unused + unexpired), EXACT
 *    redirect_uri match, PKCE S256, atomically consume it, then issue an
 *    audience-bound access token (+ rotating refresh token).
 *  - refresh_token: rotate — issue a new access+refresh, invalidate the old
 *    refresh; reuse of an already-rotated token burns the lineage.
 *
 * Every failure is a proper OAuth JSON error (invalid_request / invalid_grant /
 * unsupported_grant_type) with the right status and no-store — never a stack.
 */
import type { ActionFunctionArgs } from 'react-router';
import { findClientByClientId } from '../clients.server.js';
import { consumeAuthCode } from '../codes.server.js';
import { issueAccessAndRefresh, rotateRefreshToken } from '../tokens.server.js';

function tokenError(error: string, description: string, status = 400): Response {
  return Response.json(
    { error, error_description: description },
    {
      status,
      headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    }
  );
}

function tokenResponse(body: Record<string, unknown>): Response {
  return Response.json(body, {
    status: 200,
    headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
  });
}

async function readParams(request: Request): Promise<URLSearchParams> {
  const ct = (request.headers.get('content-type') ?? '').toLowerCase();
  if (ct.includes('application/json')) {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      const out = new URLSearchParams();
      for (const [k, val] of Object.entries(body)) {
        if (typeof val === 'string') out.set(k, val);
      }
      return out;
    } catch {
      return new URLSearchParams();
    }
  }
  try {
    const fd = await request.formData();
    const out = new URLSearchParams();
    fd.forEach((val, key) => {
      if (typeof val === 'string') out.append(key, val);
    });
    return out;
  } catch {
    return new URLSearchParams();
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return tokenError('invalid_request', 'POST required', 405);
  }

  const params = await readParams(request);
  const grantType = params.get('grant_type');

  if (grantType === 'authorization_code') {
    return handleAuthorizationCode(params);
  }
  if (grantType === 'refresh_token') {
    return handleRefreshToken(params);
  }
  return tokenError(
    'unsupported_grant_type',
    'grant_type must be authorization_code or refresh_token'
  );
}

async function handleAuthorizationCode(
  params: URLSearchParams
): Promise<Response> {
  const code = params.get('code');
  const redirectUri = params.get('redirect_uri');
  const codeVerifier = params.get('code_verifier');
  const clientId = params.get('client_id') ?? undefined;

  if (!code || !redirectUri || !codeVerifier) {
    return tokenError(
      'invalid_request',
      'code, redirect_uri, and code_verifier are required'
    );
  }

  const consumed = await consumeAuthCode({
    code,
    redirectUri,
    codeVerifier,
    clientId,
  });
  if (!consumed.ok) {
    return tokenError(consumed.error, consumed.description);
  }

  const row = consumed.row;
  const client = await findClientByClientId(row.clientId);

  const issued = await issueAccessAndRefresh({
    userId: row.userId,
    workspaceId: row.workspaceId,
    role: row.role,
    oauthClientId: client?.id ?? null,
    scope: row.scope,
    audience: row.resource,
  });

  return tokenResponse({
    access_token: issued.accessToken,
    token_type: 'Bearer',
    expires_in: issued.expiresInSec,
    refresh_token: issued.refreshToken,
    scope: issued.scope,
  });
}

async function handleRefreshToken(params: URLSearchParams): Promise<Response> {
  const refreshToken = params.get('refresh_token');
  if (!refreshToken) {
    return tokenError('invalid_request', 'refresh_token is required');
  }

  const rotated = await rotateRefreshToken(refreshToken);
  if (!rotated.ok) {
    return tokenError(rotated.error, rotated.description);
  }

  return tokenResponse({
    access_token: rotated.accessToken,
    token_type: 'Bearer',
    expires_in: rotated.expiresInSec,
    refresh_token: rotated.refreshToken,
    scope: rotated.scope,
  });
}
