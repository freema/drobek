/**
 * OAuth client store (U5, M0-04). Public PKCE clients only — no client_secret
 * is issued or stored (token_endpoint_auth_method = "none"). Two sources:
 *
 *  - `dcr`  — Dynamic Client Registration (RFC 7591), random hex client_id.
 *  - `cimd` — Client ID Metadata Document: the client_id IS the https URL of
 *             its metadata. The row mirrors the last validated document so
 *             codes/tokens can reference the client (see cimd.server.ts).
 */
import { and, count, eq, isNull, lt } from 'drizzle-orm';
import { getDb, oauthClients } from '@drobek/db';
import { generateClientId } from './crypto.server.js';

export type ClientSource = 'dcr' | 'cimd';

export interface OAuthClient {
  id: string;
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
  source: ClientSource;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface CreateClientInput {
  clientName: string;
  redirectUris: string[];
}

/** Register a new DCR public client; returns the persisted row. */
export async function createClient(
  input: CreateClientInput
): Promise<OAuthClient> {
  const clientId = generateClientId();
  const [row] = await getDb()
    .insert(oauthClients)
    .values({
      clientId,
      clientName: input.clientName,
      redirectUris: input.redirectUris,
      tokenEndpointAuthMethod: 'none',
      source: 'dcr',
    })
    .returning();
  return row as OAuthClient;
}

/** Look up a client by its public client_id. */
export async function findClientByClientId(
  clientId: string
): Promise<OAuthClient | null> {
  const [row] = await getDb()
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1);
  return (row as OAuthClient | undefined) ?? null;
}

/**
 * Insert or refresh the mirror row of a validated CIMD client (client_id = the
 * metadata URL). Name + redirect_uris always follow the latest document.
 */
export async function upsertCimdClient(input: {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}): Promise<OAuthClient> {
  const [row] = await getDb()
    .insert(oauthClients)
    .values({
      clientId: input.clientId,
      clientName: input.clientName,
      redirectUris: input.redirectUris,
      tokenEndpointAuthMethod: 'none',
      source: 'cimd',
    })
    .onConflictDoUpdate({
      target: oauthClients.clientId,
      set: {
        clientName: input.clientName,
        redirectUris: input.redirectUris,
        source: 'cimd',
      },
    })
    .returning();
  return row as OAuthClient;
}

/** Stamp that the user approved a grant for this client (it is no longer "unused"). */
export async function markClientUsed(clientId: string): Promise<void> {
  await getDb()
    .update(oauthClients)
    .set({ lastUsedAt: new Date() })
    .where(eq(oauthClients.clientId, clientId));
}

/** DCR clients that never received a grant (the PHY-76 #7 cap counts these). */
export async function countUnusedDcrClients(): Promise<number> {
  const [row] = await getDb()
    .select({ n: count() })
    .from(oauthClients)
    .where(and(eq(oauthClients.source, 'dcr'), isNull(oauthClients.lastUsedAt)));
  return Number(row?.n ?? 0);
}

/**
 * Delete DCR clients that were registered before `olderThan` and never got a
 * grant. Nothing references such a row (codes/tokens exist only after consent),
 * so this only reclaims abandoned or junk registrations.
 */
export async function pruneUnusedDcrClients(olderThan: Date): Promise<number> {
  const deleted = await getDb()
    .delete(oauthClients)
    .where(
      and(
        eq(oauthClients.source, 'dcr'),
        isNull(oauthClients.lastUsedAt),
        lt(oauthClients.createdAt, olderThan)
      )
    )
    .returning({ id: oauthClients.id });
  return deleted.length;
}
