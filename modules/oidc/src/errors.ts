import type { ModuleErrorDoc } from '@drobek/modules';

export type OidcErrorCode = 'oidc_discovery_failed' | 'oidc_token_invalid';

/**
 * A failed sign-in step. `auth` logs only the error's NAME (the code) and
 * answers the user `provider_error`; the provider logs the reason itself
 * (addresses masked). The message never carries a secret or a token.
 */
export class OidcError extends Error {
  constructor(
    readonly code: OidcErrorCode,
    reason: string
  ) {
    super(reason);
    this.name = code;
  }
}

/** skill_info('oidc').errors — reasons in the server log; an app sees `provider_error` (auth). */
export const OIDC_ERRORS: ModuleErrorDoc[] = [
  {
    code: 'oidc_discovery_failed',
    meaning:
      "The identity provider could not be used (logged by the server; the app gets auth's provider_error): no issuer or client ID, the discovery document at <issuer>/.well-known/openid-configuration is unreachable, not https, names another issuer or lacks PKCE S256, no client authentication fits, or the keys (jwks_uri) cannot be fetched.",
    fix: "Check auth.providers.oidc.issuer — it must equal the discovery document's `issuer` exactly (Microsoft: a tenant-specific issuer, not /common) — and clientId; get_app → modules.auth.secrets shows whether OIDC_CLIENT_SECRET is set (the owner sets it in the dashboard).",
  },
  {
    code: 'oidc_token_invalid',
    meaning:
      "The identity provider's answer was refused (logged by the server; the app gets auth's provider_error): the user cancelled, the code exchange failed (wrong client secret or redirect URI), or the ID token failed a check — signature, algorithm (RS256, ES256, PS256 only), issuer, audience, expiry, nonce — or carries no e-mail address.",
    fix: 'Register the redirect URI https://<dashboard>/__drobek/auth/callback/oidc at the provider, let the owner re-enter OIDC_CLIENT_SECRET in the dashboard, and set claims.email when the address is in another claim; then sign in again.',
  },
];

/** Mask e-mail addresses in a log text (`ana@x.test` → `an***@x.test`). */
export function maskAddresses(text: string): string {
  return text.replace(/([^\s@"'<>(),;:]{1,2})[^\s@"'<>(),;:]*@([^\s@"'<>(),;:]+)/g, '$1***@$2');
}
