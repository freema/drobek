/**
 * GET /.well-known/oauth-authorization-server (U5) — OAuth 2.1 AS Metadata
 * (RFC 8414). Advertises the authorize/token/register endpoints, code-only
 * response type, authorization_code + refresh_token grants, S256-only PKCE,
 * public ("none") client auth, and the drobek scope vocabulary. no-store.
 */
import type { LoaderFunctionArgs } from 'react-router';
import {
  authorizationServerIssuer,
  buildAuthorizationServerMetadata,
} from '../metadata.js';

export async function loader({ request }: LoaderFunctionArgs) {
  const issuer = authorizationServerIssuer(request);
  return Response.json(buildAuthorizationServerMetadata(issuer), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
