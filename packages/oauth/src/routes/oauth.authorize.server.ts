/**
 * GET/POST /oauth/authorize (U5) — the browser-facing authorization endpoint +
 * consent. Server half; the consent UI lives in ./oauth.authorize.tsx.
 *
 * GET: validate client_id + EXACT redirect_uri + response_type=code + PKCE
 * (S256 required) + resource; bounce to /login (carrying the authorize params)
 * when signed-out; otherwise render consent naming the client, a workspace
 * selector over the user's memberships, and the requested scopes.
 *
 * POST: re-validate, then on "allow" mint a single-use code bound to
 * (user, chosen workspace + its role, resource, granted scope, PKCE,
 * redirect_uri) and 302 back to redirect_uri?code&state. "deny" → 302 with
 * error=access_denied. Invalid params never 500 — clean OAuth errors only.
 */
import {
  data,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';
import { getSessionUser, isSuperAdmin } from '@drobek/auth';
import {
  ensurePersonalWorkspace,
  getWorkspaceById,
  listUserWorkspaces,
} from '@drobek/tenancy';
import { findClientByClientId, type OAuthClient } from '../clients.server.js';
import { issueAuthCode } from '../codes.server.js';
import { exactRedirectUriMatch, isValidResource } from '../redirect-uri.js';
import { isKnownScope, parseScopes, serializeScopes } from '../scopes.js';
import type { OAuthRole } from '../store.server.js';

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

type Validated =
  | { ok: true; client: OAuthClient; params: AuthorizeParams }
  | { ok: false; error: string; errorDescription: string };

/**
 * Structural validation shared by GET + POST. redirect_uri is validated
 * against the registered set with EXACT string equality before we ever trust
 * it — so an invalid/unknown redirect_uri is surfaced here, never redirected to.
 */
async function validate(params: AuthorizeParams): Promise<Validated> {
  if (params.responseType !== 'code') {
    return { ok: false, error: 'unsupported_response_type', errorDescription: 'response_type must be code' };
  }
  if (!params.clientId) {
    return { ok: false, error: 'invalid_request', errorDescription: 'client_id is required' };
  }
  if (!params.redirectUri) {
    return { ok: false, error: 'invalid_request', errorDescription: 'redirect_uri is required' };
  }
  const client = await findClientByClientId(params.clientId);
  if (!client) {
    return { ok: false, error: 'invalid_client', errorDescription: 'unknown client_id' };
  }
  if (!exactRedirectUriMatch(params.redirectUri, client.redirectUris)) {
    return { ok: false, error: 'invalid_request', errorDescription: 'redirect_uri is not registered for this client' };
  }
  if (!params.codeChallenge || params.codeChallengeMethod !== 'S256') {
    return { ok: false, error: 'invalid_request', errorDescription: 'PKCE with code_challenge_method=S256 is required' };
  }
  if (!params.resource || !isValidResource(params.resource)) {
    return { ok: false, error: 'invalid_request', errorDescription: 'resource must be an absolute URI (RFC 8707)' };
  }
  return { ok: true, client, params };
}

export interface AuthorizeConsentData {
  ok: true;
  clientName: string;
  redirectHost: string;
  workspaces: { id: string; slug: string; name: string; role: OAuthRole }[];
  scopes: string[];
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
    return data<AuthorizeErrorData>(
      { ok: false, error: v.error, errorDescription: v.errorDescription },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const user = await getSessionUser(request);
  if (!user) {
    const returnTo = `${url.pathname}${url.search}`;
    throw redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }

  // Guarantee the personal workspace exists so there is always ≥1 choice.
  await ensurePersonalWorkspace(user.id, user.email);
  const workspaces = await listUserWorkspaces(user.id);

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
      redirectHost,
      workspaces: workspaces.map((w) => ({
        id: w.id,
        slug: w.slug,
        name: w.name,
        role: w.role as OAuthRole,
      })),
      scopes: parseScopes(params.scope),
      params,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

/** Append error params to a validated redirect_uri and 302. */
function redirectWithError(redirectUri: string, error: string, state: string): Response {
  const target = new URL(redirectUri);
  target.searchParams.set('error', error);
  if (state) target.searchParams.set('state', state);
  return redirect(target.toString());
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const get = (k: string): string | null => {
    const v = form.get(k);
    return typeof v === 'string' ? v : null;
  };
  const params = readParams(get);

  const v = await validate(params);
  if (!v.ok) {
    // redirect_uri is NOT trusted here — render a clean 400, never redirect.
    throw data(
      { message: `${v.error}: ${v.errorDescription}` },
      { status: 400 }
    );
  }

  const user = await getSessionUser(request);
  if (!user) throw redirect('/login');

  const decision = get('decision');
  if (decision !== 'allow') {
    throw redirectWithError(params.redirectUri, 'access_denied', params.state);
  }

  // Resolve the chosen workspace + the user's role in it (super-admin override).
  const workspaceId = get('workspace_id') ?? '';
  const superAdmin = isSuperAdmin(user.email);
  const mine = await listUserWorkspaces(user.id);
  const membership = mine.find((w) => w.id === workspaceId);
  let role: OAuthRole;
  if (membership) {
    role = membership.role as OAuthRole;
  } else if (superAdmin && (await getWorkspaceById(workspaceId))) {
    role = 'workspace-admin';
  } else {
    throw data(
      { message: 'You are not a member of the selected workspace.' },
      { status: 403 }
    );
  }

  // Granted scope = the checked scope_<name> boxes, restricted to known scopes.
  const granted: string[] = [];
  for (const [k, val] of form.entries()) {
    if (!k.startsWith('scope_')) continue;
    if (val !== 'on' && val !== 'true') continue;
    const scope = k.slice('scope_'.length);
    if (isKnownScope(scope)) granted.push(scope);
  }
  const scope = serializeScopes(Array.from(new Set(granted)));

  const code = await issueAuthCode({
    clientId: v.client.clientId,
    userId: user.id,
    workspaceId,
    role,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
    scope,
    resource: params.resource,
  });

  const target = new URL(params.redirectUri);
  target.searchParams.set('code', code);
  if (params.state) target.searchParams.set('state', params.state);
  throw redirect(target.toString());
}
