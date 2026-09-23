/**
 * Resolve the client named by an authorization request (M0-04). A URL
 * client_id is a Client ID Metadata Document (fetched + validated, then
 * mirrored into oauth_clients); anything else must be a registered DCR
 * client. Either failure is `invalid_client` — shown to the user, never
 * redirected, because the redirect_uri cannot be trusted yet.
 */
import { resolveCimdMetadata, isUrlClientId, type CimdDeps } from './cimd.server.js';
import {
  findClientByClientId,
  upsertCimdClient,
  type OAuthClient,
} from './clients.server.js';

export type ClientResolution =
  | { ok: true; client: OAuthClient }
  | { ok: false; error: 'invalid_client'; description: string };

export async function resolveClient(
  clientId: string,
  deps: CimdDeps = {}
): Promise<ClientResolution> {
  if (isUrlClientId(clientId)) {
    const meta = await resolveCimdMetadata(clientId, deps);
    if (!meta.ok) {
      return {
        ok: false,
        error: 'invalid_client',
        description: `client metadata document rejected: ${meta.reason}`,
      };
    }
    return { ok: true, client: await upsertCimdClient(meta.client) };
  }
  const client = await findClientByClientId(clientId);
  if (!client || client.source !== 'dcr') {
    return { ok: false, error: 'invalid_client', description: 'unknown client_id' };
  }
  return { ok: true, client };
}
