/**
 * The `auth.provider` contribution: an authorization code flow with PKCE
 * against any OpenID Connect provider, found by discovery. `begin` answers
 * the authorization URL (state, nonce and the S256 challenge come from
 * `auth`); `callback` exchanges the code, verifies the ID token and answers
 * the identity `{ issuer, subject, email, emailVerified, name? }`. Any
 * failure throws an OidcError: `auth` answers `provider_error` and the
 * reason goes to the server log only.
 */
import {
  defineAuthProvider,
  type AuthIdentity,
  type AuthProvider,
  type AuthProviderBeginInput,
  type AuthProviderCallbackInput,
  type AuthProviderSecrets,
} from '@drobek/modules';
import {
  CLIENT_SECRET,
  CLIENT_SECRET_ENV,
  DEFAULT_LABEL,
  OIDC_CONFIG_DEFAULTS,
  PROVIDER_ID,
  devOrigins,
  effectiveConfig,
  oidcConfigSchema,
  type EffectiveConfig,
  type OidcConfig,
} from './config.js';
import { OidcError, maskAddresses } from './errors.js';
import { guardedFetch, type IdpFetch } from './http.js';
import { DEFAULT_DISCOVERY_CACHE_SEC, Idp, type Discovery, type Trust } from './idp.js';

export interface OidcProviderDeps {
  fetch?: IdpFetch;
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** The discovery cache lifetime in seconds (default: OIDC_DISCOVERY_CACHE_SEC, 3600). */
  discoveryCacheSec?: () => number;
}

type Input = AuthProviderBeginInput<OidcConfig> | AuthProviderCallbackInput<OidcConfig>;

/** OIDC_DISCOVERY_CACHE_SEC from the server's env (a provider gets no limits of its own), else the default. */
function discoveryCacheSecFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OIDC_DISCOVERY_CACHE_SEC;
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DISCOVERY_CACHE_SEC;
}

function trustOf(cfg: EffectiveConfig, env: Readonly<Record<string, string>>): Trust {
  return { devOrigins: devOrigins(env), operatorHost: cfg.fromEnv ? new URL(cfg.issuer).host : null };
}

/** Log the reason (addresses masked, never a secret or token) and rethrow; anything else becomes an OidcError. */
async function logged<T>(input: Input, step: 'begin' | 'callback', work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    const failure = err instanceof OidcError ? err : new OidcError(step === 'begin' ? 'oidc_discovery_failed' : 'oidc_token_invalid', 'unexpected failure');
    input.log.warn(`oidc: sign-in ${step} failed`, { app_id: input.app.id, error: failure.code, reason: maskAddresses(failure.message) });
    throw failure;
  }
}

type ClientAuth = { kind: 'basic' | 'post'; secret: string } | { kind: 'none' };

/** The client authentication the token endpoint takes: basic, then post with a secret; `none` without one. */
async function clientAuth(doc: Discovery, secrets: AuthProviderSecrets): Promise<ClientAuth> {
  const methods = doc.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
  const secret = await secrets.get(CLIENT_SECRET);
  if (secret) {
    if (methods.includes('client_secret_basic')) return { kind: 'basic', secret };
    if (methods.includes('client_secret_post')) return { kind: 'post', secret };
    throw new OidcError('oidc_discovery_failed', 'the token endpoint takes neither client_secret_basic nor client_secret_post');
  }
  if (methods.includes('none')) return { kind: 'none' };
  throw new OidcError('oidc_discovery_failed', `no client secret: the owner sets ${CLIENT_SECRET} (or the operator ${CLIENT_SECRET_ENV})`);
}

/** application/x-www-form-urlencoded, as RFC 6749 §2.3.1 wants client_secret_basic's parts. */
const formEncode = (v: string) => new URLSearchParams({ v }).toString().slice(2);

function emailOf(source: Record<string, unknown>, claim: string): string | null {
  const v = source[claim];
  if (typeof v !== 'string') return null;
  const email = v.trim().toLowerCase();
  return email.length > 0 && email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
}

const verified = (v: unknown) => v === true || v === 'true';

function nameOf(claims: Record<string, unknown>): string | undefined {
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const name = text(claims.name) || [text(claims.given_name), text(claims.family_name)].filter(Boolean).join(' ');
  return name ? name.slice(0, 200) : undefined;
}

export function createOidcProvider(deps: OidcProviderDeps = {}): AuthProvider<OidcConfig> {
  const idp = new Idp({
    fetch: deps.fetch ?? guardedFetch,
    now: deps.now ?? Date.now,
    discoveryCacheSec: deps.discoveryCacheSec ?? (() => discoveryCacheSecFromEnv()),
  });

  return defineAuthProvider<OidcConfig>({
    id: PROVIDER_ID,
    label: DEFAULT_LABEL,
    configSchema: oidcConfigSchema,
    configDefaults: OIDC_CONFIG_DEFAULTS,
    // trustEmail and claims decide which address a person may claim: changing them waits for the owner too.
    identityFields: ['issuer', 'clientId', 'trustEmail', 'claims'],
    secrets: [
      {
        name: CLIENT_SECRET,
        description: `The client secret of the app's client at the OpenID Connect provider (else the server's ${CLIENT_SECRET_ENV}).`,
        env: CLIENT_SECRET_ENV,
      },
    ],

    begin: (input) =>
      logged(input, 'begin', async () => {
        const cfg = effectiveConfig(input.config, input.env);
        const trust = trustOf(cfg, input.env);
        const doc = await idp.discover(cfg.issuer, trust);
        await clientAuth(doc, input.secrets);
        const url = new URL(doc.authorization_endpoint);
        const params: Record<string, string> = {
          response_type: 'code',
          client_id: cfg.clientId,
          redirect_uri: input.redirectUri,
          scope: cfg.scopes.join(' '),
          state: input.state,
          nonce: input.nonce,
          code_challenge: input.codeChallenge,
          code_challenge_method: input.codeChallengeMethod,
          ...(cfg.prompt ? { prompt: cfg.prompt } : {}),
        };
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
        return { url: url.toString() };
      }),

    callback: (input) =>
      logged(input, 'callback', async (): Promise<AuthIdentity> => {
        const cfg = effectiveConfig(input.config, input.env);
        const trust = trustOf(cfg, input.env);
        const answer = { ...(input.body ?? {}), ...input.query };
        if (answer.error !== undefined) {
          const code = /^[A-Za-z0-9_.-]{1,64}$/.test(answer.error) ? answer.error : 'unknown';
          throw new OidcError('oidc_token_invalid', `the provider answered error=${code}`);
        }
        const doc = await idp.discover(cfg.issuer, trust);
        // RFC 9207: a provider that names itself in the answer must name this issuer.
        if (answer.iss !== undefined && answer.iss !== doc.issuer) throw new OidcError('oidc_token_invalid', 'the answer names another issuer (iss)');
        const code = answer.code;
        if (typeof code !== 'string' || code.length === 0 || code.length > 4096) throw new OidcError('oidc_token_invalid', 'the answer has no code');

        const auth = await clientAuth(doc, input.secrets);
        const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: input.redirectUri, code_verifier: input.codeVerifier });
        const headers: Record<string, string> = {};
        if (auth.kind === 'basic') {
          headers.authorization = `Basic ${Buffer.from(`${formEncode(cfg.clientId)}:${formEncode(auth.secret)}`).toString('base64')}`;
        } else {
          form.set('client_id', cfg.clientId);
          if (auth.kind === 'post') form.set('client_secret', auth.secret);
        }
        const tokens = await idp.token(doc, trust, form, headers);
        const claims = await idp.verifyIdToken(tokens.id_token, doc, trust, { clientId: cfg.clientId, nonce: input.nonce });

        let source = claims;
        let email = emailOf(claims, cfg.emailClaim);
        if (!email && doc.userinfo_endpoint && typeof tokens.access_token === 'string') {
          const info = await idp.userinfo(doc, trust, tokens.access_token);
          if (info.sub !== claims.sub) throw new OidcError('oidc_token_invalid', 'userinfo names another sub');
          source = info;
          email = emailOf(info, cfg.emailClaim);
        }
        if (!email) throw new OidcError('oidc_token_invalid', `no e-mail address in the "${cfg.emailClaim}" claim of the ID token or userinfo`);
        const name = nameOf(claims) ?? nameOf(source);
        return {
          issuer: claims.iss as string,
          subject: claims.sub as string,
          email,
          emailVerified: cfg.trustEmail || verified(source.email_verified),
          ...(name ? { name } : {}),
        };
      }),
  });
}
