/**
 * GET/POST /oauth/authorize (U5, M0-04) — the browser-facing authorization
 * endpoint + consent. Server half; the consent UI lives in ./oauth.authorize.tsx.
 *
 * Validation order follows RFC 6749 §4.1.2.1: the client (a DCR client_id or
 * a CIMD metadata URL) and the EXACT redirect_uri are checked first — a
 * failure there is SHOWN (400), never redirected, because the redirect target
 * is not trusted yet. Every later failure (response_type, PKCE S256, the RFC
 * 8707 `resource` = this MCP endpoint → `invalid_target`, `invalid_scope`) is
 * redirected back with `error`, `state` and the RFC 9207 `iss`.
 *
 * GET: bounce to /login (carrying the authorize params) when signed-out;
 * otherwise render consent naming the client and the three scope checkboxes
 * (read / write / publish; only the requested ones can be granted).
 *
 * POST: re-validate, then on "allow" mint a single-use code bound to (user,
 * resource, granted scope, PKCE, redirect_uri) and 302 back with
 * code + state + iss. The token is USER-bound: no workspace is chosen here —
 * each MCP call is authorized against the caller's membership in the
 * workspace it targets. "deny" (or granting nothing) → access_denied.
 */
import {
  data,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';
import { getSessionUser } from '@drobek/auth';
import { resolveClient } from '../client-resolve.server.js';
import { markClientUsed, type OAuthClient } from '../clients.server.js';
import { issueAuthCode } from '../codes.server.js';
import { authorizationServerIssuer, isMcpResource, mcpResourceUri } from '../metadata.js';
import { exactRedirectUriMatch } from '../redirect-uri.js';
import { parseScopes, serializeScopes, SCOPES, type Scope } from '../scopes.js';

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  responseType: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  state: string;
  resource: string;
}

function readParams(get: (k: string) => string | null): AuthorizeParams {
  return {
    clientId: get('client_id') ?? '',
    redirectUri: get('redirect_uri') ?? '',
    responseType: get('response_type') ?? '',
    codeChallenge: get('code_challenge') ?? '',
    codeChallengeMethod: get('code_challenge_method') ?? '',
    scope: get('scope') ?? '',
    state: get('state') ?? '',
    resource: get('resource') ?? '',
  };
}

interface OAuthFailure {
  error: string;
  errorDescription: string;
}

type Validated =
  | { ok: true; client: OAuthClient; requested: Scope[] }
  /** Client/redirect_uri problem: SHOW it. */
  | { ok: false; show: true; failure: OAuthFailure }
  /** Anything else: redirect it (the redirect_uri is already trusted). */
  | { ok: false; show: false; failure: OAuthFailure };

/** Validation shared by GET + POST (see the module comment for the order). */
async function validate(params: AuthorizeParams): Promise<Validated> {
  const show = (error: string, errorDescription: string): Validated => ({
    ok: false,
    show: true,
    failure: { error, errorDescription },
  });
  const back = (error: string, errorDescription: string): Validated => ({
    ok: false,
    show: false,
    failure: { error, errorDescription },
  });

  if (!params.clientId) return show('invalid_request', 'client_id is required');
  if (!params.redirectUri) return show('invalid_request', 'redirect_uri is required');
  const resolved = await resolveClient(params.clientId);
  if (!resolved.ok) return show(resolved.error, resolved.description);
  const client = resolved.client;
  if (!exactRedirectUriMatch(params.redirectUri, client.redirectUris)) {
    return show('invalid_request', 'redirect_uri is not registered for this client');
  }

  if (params.responseType !== 'code') {
    return back('unsupported_response_type', 'response_type must be code');
  }
  if (!params.codeChallenge || params.codeChallengeMethod !== 'S256') {
    return back('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  }
  if (!params.resource) {
    return back('invalid_request', 'resource is required (RFC 8707)');
  }
  if (!isMcpResource(params.resource)) {
    return back('invalid_target', `resource must be ${mcpResourceUri()}`);
  }
  const requested = parseScopes(params.scope);
  if (requested.length === 0) {
    return back('invalid_scope', `scope must name at least one of: ${SCOPES.join(' ')}`);
  }
  return { ok: true, client, requested };
}

/** 302 to the (already validated) redirect_uri with RFC 6749 + RFC 9207 params. */
function redirectBack(
  request: Request,
  params: AuthorizeParams,
  values: Record<string, string>
): Response {
  const target = new URL(params.redirectUri);
  for (const [k, v] of Object.entries(values)) target.searchParams.set(k, v);
  if (params.state) target.searchParams.set('state', params.state);
  target.searchParams.set('iss', authorizationServerIssuer(request));
  return redirect(target.toString());
}

export interface AuthorizeConsentData {
  ok: true;
  clientName: string;
  /** For a CIMD client: the host that vouches for the name (its metadata URL). */
  clientHost: string | null;
  redirectHost: string;
  /** The scopes this client asked for (only these can be granted). */
  requested: Scope[];
  params: AuthorizeParams;
}
export interface AuthorizeErrorData {
  ok: false;
  error: string;
  errorDescription: string;
}
export type AuthorizeLoaderData = AuthorizeConsentData | AuthorizeErrorData;

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const params = readParams((k) => url.searchParams.get(k));

  const v = await validate(params);
  if (!v.ok) {
    if (!v.show) {
      throw redirectBack(request, params, {
        error: v.failure.error,
        error_description: v.failure.errorDescription,
      });
    }
    return data<AuthorizeErrorData>(
      { ok: false, ...v.failure },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const user = await getSessionUser(request);
  if (!user) {
    const returnTo = `${url.pathname}${url.search}`;
    throw redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }

  let redirectHost = params.redirectUri;
  try {
    redirectHost = new URL(params.redirectUri).host;
  } catch {
    /* validated above; keep raw */
  }

  return data<AuthorizeConsentData>(
    {
      ok: true,
      clientName: v.client.clientName,
      clientHost: v.client.source === 'cimd' ? new URL(v.client.clientId).host : null,
      redirectHost,
      requested: v.requested,
      params,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const get = (k: string): string | null => {
    const val = form.get(k);
    return typeof val === 'string' ? val : null;
  };
  const params = readParams(get);

  const v = await validate(params);
  if (!v.ok) {
    if (!v.show) {
      throw redirectBack(request, params, {
        error: v.failure.error,
        error_description: v.failure.errorDescription,
      });
    }
    // redirect_uri is NOT trusted here — render a clean 400, never redirect.
    throw data(
      { message: `${v.failure.error}: ${v.failure.errorDescription}` },
      { status: 400 }
    );
  }

  const user = await getSessionUser(request);
  if (!user) throw redirect('/login');

  if (get('decision') !== 'allow') {
    throw redirectBack(request, params, { error: 'access_denied' });
  }

  // Granted = the checked scope_<name> boxes ∩ what the client requested.
  const granted = v.requested.filter((s) => {
    const box = get(`scope_${s}`);
    return box === 'on' || box === 'true';
  });
  if (granted.length === 0) {
    throw redirectBack(request, params, {
      error: 'access_denied',
      error_description: 'no scope was granted',
    });
  }

  const code = await issueAuthCode({
    clientId: v.client.clientId,
    userId: user.id,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
    scope: serializeScopes(granted),
    resource: mcpResourceUri(),
  });
  await markClientUsed(v.client.clientId);

  throw redirectBack(request, params, { code });
}
