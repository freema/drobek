/**
 * The per-app config of the oidc provider (`auth.providers.oidc` — the
 * module itself has no config) and the operator's env fallback of one IdP
 * for the whole server (`AUTH_OIDC_ISSUER` + `AUTH_OIDC_CLIENT_ID`).
 */
import { z } from '@drobek/modules';
import { OidcError } from './errors.js';

export const PROVIDER_ID = 'oidc';
export const CLIENT_SECRET = 'OIDC_CLIENT_SECRET';
export const CLIENT_SECRET_ENV = 'AUTH_OIDC_CLIENT_SECRET';
const ISSUER_ENV = 'AUTH_OIDC_ISSUER';
const CLIENT_ID_ENV = 'AUTH_OIDC_CLIENT_ID';
/** Dev/test only (ignored in production): exact origins that may serve the IdP over http from a private address. */
const DEV_ORIGINS_ENV = 'AUTH_OIDC_DEV_ORIGINS';

const DEFAULT_SCOPES = ['openid', 'email', 'profile'];
export const DEFAULT_LABEL = 'Company account';

const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]{1,64}$/;
const CONTROL_CODES = new Set([...Array(32).keys(), 0x7f, 0x2028, 0x2029]);

/** A control character or a line/paragraph separator. */
export function hasControl(text: string): boolean {
  for (const ch of text) if (CONTROL_CODES.has(ch.codePointAt(0)!)) return true;
  return false;
}

const production = () => process.env.NODE_ENV === 'production';

/** An issuer URL: https (http only outside production), no credentials, query or fragment. */
function issuerProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be a URL';
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !production())) return 'must be an https URL';
  if (url.username || url.password) return 'must not carry credentials';
  if (url.search || url.hash || value.includes('?') || value.includes('#')) return 'must not have a query or fragment';
  return null;
}

const issuer = z
  .string()
  .max(2048)
  .superRefine((v, ctx) => {
    const problem = issuerProblem(v);
    if (problem) ctx.addIssue({ code: 'custom', message: `issuer ${problem}` });
  })
  .meta({
    title: 'Issuer',
    description:
      'The identity provider’s issuer URL, exactly as its /.well-known/openid-configuration names it (e.g. https://accounts.google.com, https://login.microsoftonline.com/<tenant id>/v2.0). Empty: the server’s AUTH_OIDC_ISSUER.',
  });

export const oidcConfigSchema = z.strictObject({
  issuer: issuer.optional(),
  clientId: z
    .string()
    .min(1)
    .max(255)
    .refine((v) => !hasControl(v) && v.trim() === v, 'clientId must be one trimmed line')
    .optional()
    .meta({ title: 'Client ID', description: 'The client (application) ID registered at the identity provider. Empty with no issuer: the server’s AUTH_OIDC_CLIENT_ID.' }),
  scopes: z
    .array(z.string().regex(SCOPE_TOKEN, 'a scope is one token without spaces or quotes'))
    .min(1)
    .max(20)
    .refine((s) => s.includes('openid'), 'scopes must include "openid"')
    .meta({ title: 'Scopes', description: 'Scopes asked for (default openid, email, profile).' }),
  trustEmail: z.boolean().meta({
    title: 'Trust the e-mail address',
    description: 'Treat every address the provider sends as verified, also without email_verified (e.g. Microsoft Entra ID). Only for a provider that controls its users’ addresses.',
  }),
  label: z
    .string()
    .min(1)
    .max(40)
    .refine((l) => !hasControl(l) && l.trim() === l, 'label must be one trimmed line')
    .meta({ title: 'Button label', description: 'The sign-in button reads “Continue with <label>” (default “Company account”).' }),
  claims: z
    .strictObject({
      email: z
        .string()
        .regex(/^[A-Za-z0-9_.:-]{1,64}$/, 'a claim name')
        .optional()
        .meta({ title: 'E-mail claim', description: 'The claim that holds the address (default email; e.g. preferred_username or upn).' }),
    })
    .optional()
    .meta({ title: 'Claims' }),
  prompt: z
    .enum(['select_account', 'login', 'consent'])
    .optional()
    .meta({ title: 'Prompt', description: 'select_account: always show the account chooser.' }),
});

export type OidcConfig = z.infer<typeof oidcConfigSchema>;

export const OIDC_CONFIG_DEFAULTS: Partial<OidcConfig> = {
  scopes: DEFAULT_SCOPES,
  trustEmail: false,
  label: DEFAULT_LABEL,
};

/** What one sign-in runs with: the app's config over the defaults, the issuer and client from the app or the operator. */
export interface EffectiveConfig {
  issuer: string;
  clientId: string;
  scopes: string[];
  trustEmail: boolean;
  emailClaim: string;
  prompt?: string;
  /** The issuer came from AUTH_OIDC_ISSUER (the operator vouches for its host). */
  fromEnv: boolean;
}

/**
 * The effective config of one call. `AUTH_OIDC_CLIENT_ID` only pairs with
 * `AUTH_OIDC_ISSUER`: an app with its own issuer names its own client; an app
 * without one may still name its own client at the server's issuer.
 */
export function effectiveConfig(raw: unknown, env: Readonly<Record<string, string>>): EffectiveConfig {
  const parsed = oidcConfigSchema.safeParse({ ...OIDC_CONFIG_DEFAULTS, ...(raw as object) });
  if (!parsed.success) throw new OidcError('oidc_discovery_failed', 'the oidc config does not pass its schema');
  const c = parsed.data;
  const envIssuer = env[ISSUER_ENV]?.trim();
  const fromEnv = !c.issuer;
  const iss = c.issuer ?? envIssuer;
  if (!iss) throw new OidcError('oidc_discovery_failed', `no issuer: set providers.oidc.issuer or ${ISSUER_ENV}`);
  if (fromEnv && issuerProblem(iss)) throw new OidcError('oidc_discovery_failed', `${ISSUER_ENV} is not a usable issuer URL`);
  const clientId = c.clientId ?? (fromEnv ? env[CLIENT_ID_ENV]?.trim() : undefined);
  if (!clientId) throw new OidcError('oidc_discovery_failed', `no client id: set providers.oidc.clientId${fromEnv ? ` or ${CLIENT_ID_ENV}` : ''}`);
  return {
    issuer: iss,
    clientId,
    scopes: c.scopes ?? DEFAULT_SCOPES,
    trustEmail: c.trustEmail === true,
    emailClaim: c.claims?.email ?? 'email',
    ...(c.prompt ? { prompt: c.prompt } : {}),
    fromEnv,
  };
}

/** The exact dev/test origins that may serve the IdP over http from a private address (never in production). */
export function devOrigins(env: Readonly<Record<string, string>>): Set<string> {
  const out = new Set<string>();
  if (production()) return out;
  for (const entry of (env[DEV_ORIGINS_ENV] ?? '').split(/[,\s]+/)) {
    if (!entry) continue;
    try {
      const origin = new URL(entry).origin;
      if (origin !== 'null' && origin === entry) out.add(origin);
    } catch {
      /* not a URL → ignored */
    }
  }
  return out;
}
