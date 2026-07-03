/**
 * Authorization code issue + single-use consume (U5). The code is opaque; only
 * its SHA-256 hash is stored. Consumption is atomic (markAuthCodeUsed flips
 * used false→true and reports whether THIS caller won the race), so a code is
 * usable exactly once even under concurrent /oauth/token calls.
 */
import { AUTH_CODE_TTL_MS } from './constants.js';
import { generateOpaqueToken, hashToken, verifyPkceS256 } from './crypto.server.js';
import { exactRedirectUriMatch } from './redirect-uri.js';
import {
  defaultOAuthStore,
  type AuthCodeRow,
  type OAuthRole,
  type OAuthStore,
} from './store.server.js';

export interface IssueAuthCodeInput {
  clientId: string;
  userId: string;
  workspaceId: string;
  role: OAuthRole;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  resource: string;
}

/** Mint a single-use PKCE authorization code; returns the RAW code. */
export async function issueAuthCode(
  input: IssueAuthCodeInput,
  store: OAuthStore = defaultOAuthStore(),
  now: number = Date.now()
): Promise<string> {
  const code = generateOpaqueToken(32);
  await store.insertAuthCode({
    codeHash: hashToken(code),
    clientId: input.clientId,
    userId: input.userId,
    workspaceId: input.workspaceId,
    role: input.role,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    scope: input.scope,
    resource: input.resource,
    expiresAt: new Date(now + AUTH_CODE_TTL_MS),
  });
  return code;
}

export type ConsumeAuthCodeResult =
  | { ok: true; row: AuthCodeRow }
  | { ok: false; error: 'invalid_grant' | 'invalid_request'; description: string };

export interface ConsumeAuthCodeInput {
  code: string;
  redirectUri: string;
  codeVerifier: string;
  /** If present, MUST equal the code's client_id. */
  clientId?: string;
}

/**
 * Validate + atomically consume an authorization code. Every failure collapses
 * to a generic invalid_grant (no oracle): unknown/expired/used code, redirect
 * mismatch, client mismatch, or PKCE failure.
 */
export async function consumeAuthCode(
  input: ConsumeAuthCodeInput,
  store: OAuthStore = defaultOAuthStore(),
  now: number = Date.now()
): Promise<ConsumeAuthCodeResult> {
  const row = await store.findAuthCodeByHash(hashToken(input.code));
  if (!row) {
    return { ok: false, error: 'invalid_grant', description: 'invalid authorization code' };
  }
  if (row.used) {
    return { ok: false, error: 'invalid_grant', description: 'authorization code already used' };
  }
  if (row.expiresAt.getTime() <= now) {
    return { ok: false, error: 'invalid_grant', description: 'authorization code expired' };
  }
  if (!exactRedirectUriMatch(input.redirectUri, [row.redirectUri])) {
    return { ok: false, error: 'invalid_grant', description: 'redirect_uri mismatch' };
  }
  if (input.clientId !== undefined && input.clientId !== row.clientId) {
    return { ok: false, error: 'invalid_grant', description: 'client_id mismatch' };
  }
  if (row.codeChallengeMethod !== 'S256') {
    return { ok: false, error: 'invalid_grant', description: 'unsupported code_challenge_method' };
  }
  if (!verifyPkceS256(input.codeVerifier, row.codeChallenge)) {
    return { ok: false, error: 'invalid_grant', description: 'PKCE verification failed' };
  }

  // Atomic single-use flip — loses cleanly to a concurrent winner.
  const won = await store.markAuthCodeUsed(row.id);
  if (!won) {
    return { ok: false, error: 'invalid_grant', description: 'authorization code already used' };
  }
  return { ok: true, row };
}
