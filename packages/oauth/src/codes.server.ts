/**
 * Authorization code issue + single-use consume (U5). The code is opaque; only
 * its SHA-256 hash is stored. Consumption is atomic (markAuthCodeUsed flips
 * used false→true and reports whether THIS caller won the race), so a code is
 * usable exactly once even under concurrent /oauth/token calls.
 *
 * Presentation burns the code (NSO-332, RFC 6749 §4.1.2 / OAuth 2.1 §4.1.3):
 * a FAILED exchange (wrong verifier, redirect_uri, client, expired) consumes
 * it too, so a PKCE guess gets exactly one try. Presenting an already-consumed
 * code is replay: the refresh-token lineage the code minted is revoked with
 * the refresh-reuse mechanism (revokeLineage). The link is the lineage's first
 * refresh-token id, derived from the code row id (authCodeRefreshTokenId) —
 * no code→token column.
 */
import { AUTH_CODE_TTL_MS } from './constants.js';
import { generateOpaqueToken, hashToken, verifyPkceS256 } from './crypto.server.js';
import { exactRedirectUriMatch } from './redirect-uri.js';
import { revokeLineage } from './tokens.server.js';
import {
  defaultOAuthStore,
  type AuthCodeRow,
  type OAuthStore,
} from './store.server.js';

export interface IssueAuthCodeInput {
  clientId: string;
  userId: string;
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
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    scope: input.scope,
    resource: input.resource,
    expiresAt: new Date(now + AUTH_CODE_TTL_MS),
  });
  return code;
}

/**
 * The row id of the first refresh token minted by exchanging the code `codeId`
 * (its successors hang off it via rotated_to). Deterministic, so a replayed
 * code finds the lineage it started.
 */
export function authCodeRefreshTokenId(codeId: string): string {
  return `ac_${codeId}`;
}

export type ConsumeAuthCodeResult =
  | {
      ok: true;
      row: AuthCodeRow;
      /** Pass to issueAccessAndRefresh so a replay of this code can revoke it. */
      refreshTokenId: string;
    }
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
 * to invalid_grant: unknown/expired/used code, redirect mismatch, client
 * mismatch, or PKCE failure. Any failure on a known code consumes it; a used
 * code revokes the tokens it was exchanged for.
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
    await revokeCodeLineage(row, store);
    return { ok: false, error: 'invalid_grant', description: 'authorization code already used' };
  }

  const failure = checkExchange(row, input, now);
  // Atomic single-use flip on success AND failure — loses cleanly to a
  // concurrent winner, which makes this call a replay of a consumed code.
  const won = await store.markAuthCodeUsed(row.id);
  if (!won) {
    await revokeCodeLineage(row, store);
    return { ok: false, error: 'invalid_grant', description: 'authorization code already used' };
  }
  if (failure) {
    return { ok: false, error: 'invalid_grant', description: failure };
  }
  return { ok: true, row, refreshTokenId: authCodeRefreshTokenId(row.id) };
}

/** The reason an exchange of an unused code fails, or null when it is valid. */
function checkExchange(
  row: AuthCodeRow,
  input: ConsumeAuthCodeInput,
  now: number
): string | null {
  if (row.expiresAt.getTime() <= now) return 'authorization code expired';
  if (!exactRedirectUriMatch(input.redirectUri, [row.redirectUri])) {
    return 'redirect_uri mismatch';
  }
  if (input.clientId !== undefined && input.clientId !== row.clientId) {
    return 'client_id mismatch';
  }
  if (row.codeChallengeMethod !== 'S256') return 'unsupported code_challenge_method';
  if (!verifyPkceS256(input.codeVerifier, row.codeChallenge)) {
    return 'PKCE verification failed';
  }
  return null;
}

/**
 * Replay of a consumed code: burn the refresh lineage (and the grant's access
 * tokens) it was exchanged for. A code consumed by a failed exchange minted
 * nothing, so there is nothing to find.
 */
async function revokeCodeLineage(row: AuthCodeRow, store: OAuthStore): Promise<void> {
  const first = await store.findRefreshTokenById(authCodeRefreshTokenId(row.id));
  if (first) await revokeLineage(first, store);
}
