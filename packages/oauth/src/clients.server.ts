/**
 * Dynamic Client Registration store (U5). Public PKCE clients only — no
 * client_secret is issued or stored (token_endpoint_auth_method = "none").
 */
import { eq } from 'drizzle-orm';
import { getDb, oauthClients } from '@drobek/db';
import { generateClientId } from './crypto.server.js';

export interface OAuthClient {
  id: string;
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
  createdAt: Date;
}

export interface CreateClientInput {
  clientName: string;
  redirectUris: string[];
}

/** Register a new public client; returns the persisted row. */
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
