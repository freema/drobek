/**
 * Pure, client-safe shaping for the account pages (M2-04, NSO-284):
 * /me/api-keys and /me/connections. The loaders hand db rows in; the pages get
 * display-ready strings (deterministic UTC times, so SSR and hydration match).
 */
import { formatTimestamp } from './view.js';

/** Longest API key name accepted (display + audit meta). */
export const API_KEY_NAME_MAX = 80;

/** Live (unrevoked) keys a user may hold at once. */
export const API_KEYS_MAX_LIVE = 25;

export interface ApiKeyRowInput {
  id: string;
  name: string;
  scopes: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface ApiKeyItem {
  id: string;
  name: string;
  scopes: string[];
  status: 'active' | 'revoked';
  created: string;
  /** '—' when the key was never used. */
  lastUsed: string;
  revoked: string | null;
}

/** Active keys first (newest first), then revoked ones (most recently revoked first). */
export function shapeApiKeys(rows: ApiKeyRowInput[]): ApiKeyItem[] {
  const active = rows
    .filter((r) => r.revokedAt === null)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
  const revoked = rows
    .filter((r) => r.revokedAt !== null)
    .sort(
      (a, b) =>
        (b.revokedAt as Date).getTime() - (a.revokedAt as Date).getTime() ||
        b.id.localeCompare(a.id)
    );
  return [...active, ...revoked].map((r) => ({
    id: r.id,
    name: r.name,
    scopes: r.scopes.split(/\s+/).filter(Boolean),
    status: r.revokedAt === null ? 'active' : 'revoked',
    created: formatTimestamp(r.createdAt.toISOString()),
    lastUsed: formatTimestamp(r.lastUsedAt?.toISOString() ?? null),
    revoked: r.revokedAt ? formatTimestamp(r.revokedAt.toISOString()) : null,
  }));
}

export interface ConnectionRowInput {
  oauthClientId: string;
  clientId: string;
  clientName: string;
  source: 'dcr' | 'cimd';
  scope: string;
  lastUsedAt: Date;
}

export interface ConnectionItem {
  /** oauth_clients.id — the revoke form's value. */
  id: string;
  /** The public client_id (a URL for CIMD clients). */
  clientId: string;
  name: string;
  /** Human label for how the client registered. */
  source: 'dcr' | 'cimd';
  sourceLabel: string;
  scopes: string[];
  lastUsed: string;
}

export function shapeConnections(rows: ConnectionRowInput[]): ConnectionItem[] {
  return rows.map((r) => ({
    id: r.oauthClientId,
    clientId: r.clientId,
    name: r.clientName,
    source: r.source,
    sourceLabel: r.source === 'cimd' ? 'Client ID Metadata Document' : 'Dynamic registration',
    scopes: r.scope.split(/\s+/).filter(Boolean),
    lastUsed: formatTimestamp(r.lastUsedAt.toISOString()),
  }));
}

export type ApiKeyFormCheck =
  | { ok: true; name: string; scopes: string[] }
  | { ok: false; error: string };

/**
 * Validate the create form: a 1..API_KEY_NAME_MAX character name and at least
 * one scope out of `known` (unknown scope values are refused, not dropped).
 */
export function checkApiKeyForm(
  rawName: unknown,
  rawScopes: unknown[],
  known: readonly string[]
): ApiKeyFormCheck {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!name) return { ok: false, error: 'Give the key a name.' };
  if (name.length > API_KEY_NAME_MAX) {
    return { ok: false, error: `The name can have at most ${API_KEY_NAME_MAX} characters.` };
  }
  const scopes: string[] = [];
  for (const s of rawScopes) {
    if (typeof s !== 'string' || !known.includes(s)) {
      return { ok: false, error: 'Unknown scope.' };
    }
    if (!scopes.includes(s)) scopes.push(s);
  }
  if (scopes.length === 0) return { ok: false, error: 'Pick at least one scope.' };
  return { ok: true, name, scopes: known.filter((k) => scopes.includes(k)) };
}
