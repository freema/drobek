import { createHash } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { loginViaEmail, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import {
  consentAndCapture,
  exchangeCode,
  mcpResource,
  pkcePair,
  rawInitialize,
  registerClient,
  type TokenBody,
} from './helpers/mcp';
import { withDb } from './helpers/seed';

/**
 * OAuth refresh against the stack:
 *   (1) the same refresh token sent twice within the retry grace (60 s) — a
 *       client retrying after a lost response, or two sessions sharing one
 *       stored token — answers 200 both times, and both access tokens work
 *       on /mcp;
 *   (2) reuse after the grace burns only its own lineage: of two
 *       authorizations of the same user and client, lineage 1's tokens die
 *       while lineage 2's access token keeps working on /mcp and its refresh
 *       token still rotates. The stack's clock cannot move, so the spec moves
 *       lineage 1's first use back in the database.
 */

async function refresh(
  request: APIRequestContext,
  refreshToken: string | undefined,
  clientId: string
): Promise<{ status: number; body: TokenBody }> {
  const res = await request.post(`${BASE_URL_WEB}/oauth/token`, {
    form: { grant_type: 'refresh_token', refresh_token: refreshToken ?? '', client_id: clientId },
  });
  return { status: res.status(), body: (await res.json()) as TokenBody };
}

/** Consent + code exchange: a new lineage for the signed-in user and `clientId`. */
async function authorize(
  page: Page,
  request: APIRequestContext,
  clientId: string,
  resource: string
): Promise<TokenBody> {
  const { verifier, challenge } = pkcePair();
  const redirect = await consentAndCapture(page, { clientId, challenge, resource, scope: 'read' });
  const code = redirect.searchParams.get('code');
  expect(code, 'authorization code').toBeTruthy();
  const tok = await exchangeCode(request, { code: code as string, verifier, clientId });
  expect(tok.status, 'token exchange').toBe(200);
  return tok.body;
}

async function mcpStatus(request: APIRequestContext, accessToken: string | undefined): Promise<number> {
  return (await rawInitialize(request, { Authorization: `Bearer ${accessToken ?? ''}` })).status();
}

test('OAuth refresh: a retry within the grace gets a pair; reuse after it burns only its own lineage @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const resource = await mcpResource(request);
  const clientId = await registerClient(request);
  await loginViaEmail(page, request, uniqueEmail('refresh'));

  // (1) One refresh token, sent twice.
  const one = await authorize(page, request, clientId, resource);
  const first = await refresh(request, one.refresh_token, clientId);
  const retry = await refresh(request, one.refresh_token, clientId);
  expect(first.status).toBe(200);
  expect(retry.status).toBe(200);
  expect(retry.body.refresh_token).toBeTruthy();
  expect(retry.body.refresh_token).not.toBe(first.body.refresh_token);
  expect(await mcpStatus(request, first.body.access_token)).toBe(200);
  expect(await mcpStatus(request, retry.body.access_token)).toBe(200);

  // (2) A second authorization of the same user and client: lineage 2.
  const two = await authorize(page, request, clientId, resource);

  // Lineage 1's first token was used longer ago than the grace → reuse.
  const hash = createHash('sha256').update(one.refresh_token as string).digest('hex');
  await withDb((c) =>
    c.query(`UPDATE oauth_refresh_tokens SET used_at = used_at - interval '5 minutes' WHERE token_hash = $1`, [hash])
  );
  const reuse = await refresh(request, one.refresh_token, clientId);
  expect(reuse.status).toBe(400);
  expect(reuse.body.error).toBe('invalid_grant');
  expect(reuse.body.access_token).toBeUndefined();

  // Lineage 1 is burned: its access tokens are 401, its newest refresh token is invalid_grant.
  for (const access of [one.access_token, first.body.access_token, retry.body.access_token]) {
    expect(await mcpStatus(request, access)).toBe(401);
  }
  const burned = await refresh(request, retry.body.refresh_token, clientId);
  expect(burned.status).toBe(400);
  expect(burned.body.error).toBe('invalid_grant');

  // Lineage 2 keeps working.
  expect(await mcpStatus(request, two.access_token)).toBe(200);
  const rotated = await refresh(request, two.refresh_token, clientId);
  expect(rotated.status).toBe(200);
  expect(await mcpStatus(request, rotated.body.access_token)).toBe(200);
});
