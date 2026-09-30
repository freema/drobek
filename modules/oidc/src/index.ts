/**
 * drobek-module-oidc — the BUILT-IN platform module `oidc` (NSO-351): company
 * sign-in with any OpenID Connect provider (Google, Microsoft Entra ID, Okta,
 * Keycloak, Auth0) through the auth module's `auth.provider` slot.
 *
 *   DROBEK_MODULES=auth,…,oidc  → this package (`modules/oidc` in the drobek
 *                                 repo, a dependency of the server).
 *
 * The module has no config, routes, SDK or tables of its own: an app turns it
 * on in the AUTH config (`providers.oidc: { enabled, issuer, clientId, … }`,
 * the owner confirms), the owner sets `OIDC_CLIENT_SECRET` in the dashboard,
 * and `drobek.auth.signIn('oidc')` / `<LoginGate>` start the sign-in. `auth`
 * keeps state, nonce, PKCE, the allowlist, users and sessions; this module
 * proves the identity (provider.ts).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineModule, z, type DrobekModule } from '@drobek/modules';
import { OIDC_ERRORS } from './errors.js';
import { DEFAULT_DISCOVERY_CACHE_SEC } from './idp.js';
import { createOidcProvider, type OidcProviderDeps } from './provider.js';

export { OIDC_CONFIG_DEFAULTS, oidcConfigSchema, type OidcConfig } from './config.js';
export { OidcError, type OidcErrorCode } from './errors.js';
export { createOidcProvider, type OidcProviderDeps } from './provider.js';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

type NoConfig = Record<string, never>;

/** The module (tests pass a fake fetch and clock). */
export function createOidcModule(deps: OidcProviderDeps = {}): DrobekModule<NoConfig> {
  return defineModule<NoConfig>({
    name: 'oidc',
    version: '1.0.0',
    contract: '^1.1',
    requires: ['auth'],
    skill: {
      useWhen:
        'people should sign in to the app with their company account (Google Workspace, Microsoft Entra ID, Okta, Keycloak, Auth0 or another OpenID Connect provider) instead of an e-mailed code',
      markdown: readFileSync(here('../SKILL.md'), 'utf8'),
    },
    configSchema: z.strictObject({}) as unknown as z.ZodType<NoConfig>,
    configDefaults: {},
    limits: [
      {
        env: 'OIDC_DISCOVERY_CACHE_SEC',
        default: DEFAULT_DISCOVERY_CACHE_SEC,
        meaning: "seconds an identity provider's discovery document is cached (server-wide; its keys are cached 1 hour)",
      },
    ],
    errors: OIDC_ERRORS,
    contributes: { 'auth.provider': createOidcProvider(deps) },
  });
}

export default createOidcModule();
