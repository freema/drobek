/**
 * The account area's audited mutations (M2-04, NSO-284): personal API keys
 * and OAuth connections. @drobek/oauth owns the rows; this layer adds the
 * per-user guards and the audit trail.
 *
 * Audit placement: keys and grants belong to a USER, not a workspace, but
 * `audit_log` is workspace-scoped (Activity is read per workspace). Account
 * events therefore land in the actor's PERSONAL workspace (always present
 * after sign-in, workspace-admin = the user), where the user reads them in
 * Activity. `meta` carries names/scopes/counts only — never a key or token.
 */
import { actorKindForSurface, AUDIT_ACTIONS, AUDIT_SUBJECT_TYPES, writeAudit } from '@drobek/audit';
import {
  createApiKey,
  listApiKeys,
  revokeConnection,
  revokeUserApiKey,
  type Scope,
} from '@drobek/oauth';
import { ensurePersonalWorkspace } from '@drobek/tenancy';
import { API_KEYS_MAX_LIVE } from './account-view.js';

export interface AccountUser {
  id: string;
  email: string;
}

/** A refusal the page shows as-is (400); anything else is a 500. */
export class AccountError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

async function personalWorkspaceId(user: AccountUser): Promise<string> {
  return (await ensurePersonalWorkspace(user.id, user.email)).id;
}

export interface CreatedAccountKey {
  id: string;
  name: string;
  scopes: string[];
  /** The raw key — returned ONCE for display; never stored or logged. */
  key: string;
}

/** Create an API key for the signed-in user (audited `api_key.create`). */
export async function createAccountApiKey(
  user: AccountUser,
  input: { name: string; scopes: string[] }
): Promise<CreatedAccountKey> {
  const live = (await listApiKeys(user.id)).filter((k) => k.revokedAt === null);
  if (live.length >= API_KEYS_MAX_LIVE) {
    throw new AccountError(
      `You already have ${API_KEYS_MAX_LIVE} active keys — revoke one you no longer use first.`
    );
  }
  // Resolve the audit workspace BEFORE minting, so a failure there never
  // leaves a live key the user was not shown.
  const workspaceId = await personalWorkspaceId(user);
  const created = await createApiKey({
    userId: user.id,
    name: input.name,
    scopes: input.scopes as Scope[],
  });
  const scopes = created.scopes.split(' ');
  await writeAudit({
    workspaceId,
    actorUserId: user.id,
    actorKind: actorKindForSurface('web'),
    action: AUDIT_ACTIONS.apiKeyCreate,
    subjectType: AUDIT_SUBJECT_TYPES.apiKey,
    target: created.id,
    meta: { name: input.name, scopes },
  });
  return { id: created.id, name: input.name, scopes, key: created.key };
}

/** Revoke one of the user's keys (audited `api_key.revoke`); 404 when not theirs/live. */
export async function revokeAccountApiKey(user: AccountUser, keyId: string): Promise<void> {
  const revoked = await revokeUserApiKey(user.id, keyId);
  if (!revoked) throw new AccountError('No such active key.', 404);
  await writeAudit({
    workspaceId: await personalWorkspaceId(user),
    actorUserId: user.id,
    actorKind: actorKindForSurface('web'),
    action: AUDIT_ACTIONS.apiKeyRevoke,
    subjectType: AUDIT_SUBJECT_TYPES.apiKey,
    target: revoked.id,
    meta: { name: revoked.name, scopes: revoked.scopes.split(' ') },
  });
}

/**
 * Revoke an OAuth client's access for the user (audited `oauth_client.revoke`):
 * every access + refresh token and pending code of that client for this user
 * is deleted. 404 when the user holds nothing for it.
 */
export async function revokeAccountConnection(
  user: AccountUser,
  oauthClientId: string
): Promise<void> {
  const revoked = await revokeConnection(user.id, oauthClientId);
  if (!revoked) throw new AccountError('No such connection.', 404);
  await writeAudit({
    workspaceId: await personalWorkspaceId(user),
    actorUserId: user.id,
    actorKind: actorKindForSurface('web'),
    action: AUDIT_ACTIONS.oauthClientRevoke,
    subjectType: AUDIT_SUBJECT_TYPES.oauthClient,
    target: revoked.clientId,
    meta: {
      client_name: revoked.clientName,
      source: revoked.source,
      access_tokens: revoked.accessTokens,
      refresh_tokens: revoked.refreshTokens,
    },
  });
}
