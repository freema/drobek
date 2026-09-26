/**
 * End-user sign-in providers (NSO-348, contract 1.1): the typed contract of
 * the two slots the built-in `auth` module offers other modules.
 *
 *   `auth.provider` — a way to sign in besides the e-mail code (OIDC, SAML, …).
 *     The provider only proves an identity `{ subject, email, emailVerified,
 *     name? }`; `auth` keeps everything else — the allowlist, roles,
 *     `mod_auth_users`, the session, `drobek.auth`, `<LoginGate>`.
 *   `auth.signedIn` — an observer told about every successful sign-in (e.g.
 *     a CRM sync); its failure is logged and never blocks the sign-in.
 *
 * A module contributes one of each at most:
 *
 *   export default defineModule({
 *     name: 'oidc', …,
 *     requires: ['auth'],
 *     contributes: { 'auth.provider': defineAuthProvider({ id: 'oidc', label: 'Company SSO', … }) },
 *   });
 *
 * The flow (docs/MODULES.md "Auth providers"): the app calls
 * `drobek.auth.signIn(id)` → `POST /__drobek/v1/auth/begin` on the app host →
 * `begin()` answers the IdP URL (state, nonce and a PKCE S256 challenge made
 * by `auth`) → the IdP redirects to the ONE callback on the dashboard host,
 * `/__drobek/auth/callback/<id>` (the `redirectUri`) → `callback()` answers
 * the verified identity → a one-time handoff code carries it back to the app
 * host, which sets the host-only session cookie.
 *
 * Providers are operator-installed server code (the module trust model);
 * the types here are what `auth` guarantees them and asks of them.
 */
import type { Logger } from '@drobek/core';
import type { DB } from '@drobek/db';
import { z, type ZodType } from 'zod';
import type { EndUser, HookApp, ModuleSecretDoc } from './contract.js';

/** Provider ids: lowercase letters and digits, 2–16 characters (a URL segment, a config key, a secret prefix). */
export const AUTH_PROVIDER_ID_RE = /^[a-z][a-z0-9]{1,15}$/;

/** The provider id of the e-mail code (in `mod_auth_users.provider` and sessions) — no contribution may take it. */
export const EMAIL_PROVIDER_ID = 'email';

/** The identity a provider proved (the IdP's verified answer — never a value the browser sent). */
export interface AuthIdentity {
  /** The IdP's stable, unique id of the person (OIDC `sub`, SAML NameID) — max 255 characters. */
  subject: string;
  /** Their e-mail address (normalized to lower case by `auth`). */
  email: string;
  /**
   * The IdP vouches for the address. `auth` refuses a sign-in with an
   * unverified address (`email_not_verified`): the allowlist, `adminEmails`
   * and the workspace-editor rule all decide by the address.
   */
  emailVerified: boolean;
  /** A display name (optional, max 200 characters; passed to `auth.signedIn` observers, not stored). */
  name?: string;
}

/**
 * A secret a provider uses, declared under the `auth` module (per app,
 * entered in the dashboard only). `name` starts with `<ID>_` (upper case),
 * e.g. `OIDC_CLIENT_SECRET`.
 */
export interface AuthProviderSecretDoc extends ModuleSecretDoc {
  /**
   * The operator's env var used when the app has no value of its own
   * (`AUTH_<ID>_…`, e.g. `AUTH_OIDC_CLIENT_SECRET`) — one IdP for the whole
   * self-hosted server.
   */
  env?: string;
}

/** The provider's secrets for ONE app: its declared names only (the app's value, else the declared env fallback). */
export interface AuthProviderSecrets {
  get(name: string): Promise<string | null>;
}

interface AuthProviderInput<Config> {
  app: HookApp;
  /** The app's config of THIS provider (`auth.providers.<id>` without `enabled`), as its configSchema parsed it. */
  config: Config;
  secrets: AuthProviderSecrets;
  /**
   * The operator's `AUTH_<ID>_*` env vars (only those) — a provider's env
   * fallback for config it may take from the server instead of the app.
   */
  env: Readonly<Record<string, string>>;
  /**
   * `<dashboard origin>/__drobek/auth/callback/<id>` — the ONE redirect URI
   * to register at the IdP (the same for every app of the server).
   */
  redirectUri: string;
  /** Opaque, signed and single-use: send it to the IdP (OIDC `state`, SAML `RelayState`), it comes back to the callback. */
  state: string;
  /** Random per sign-in (OIDC `nonce`): check the IdP's answer carries it. */
  nonce: string;
  log: Logger;
}

export interface AuthProviderBeginInput<Config = unknown> extends AuthProviderInput<Config> {
  /** PKCE: `BASE64URL(SHA-256(code_verifier))` — the verifier stays on the server. */
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

/** Where the browser goes to sign in: the IdP's authorization URL (a SAML provider: its HTTP-Redirect binding). */
export interface AuthProviderBeginResult {
  /** https (http only outside production). */
  url: string;
}

export interface AuthProviderCallbackInput<Config = unknown> extends AuthProviderInput<Config> {
  /**
   * The callback's query parameters (first value of each). `auth` found the
   * sign-in by its `state` (the `state` or `RelayState` parameter / form
   * field) and consumed it before calling the provider.
   */
  query: Record<string, string>;
  /** The form fields of a POST callback (`application/x-www-form-urlencoded`, e.g. a SAML response), else null. */
  body: Record<string, string> | null;
  /** The PKCE verifier of this sign-in (send it with the token request). */
  codeVerifier: string;
}

/**
 * A sign-in provider (the `auth.provider` slot). `begin` and `callback` are
 * called unbound (`provider.begin(input)` on the parsed contribution): do
 * not rely on `this`. A throw is logged by `auth` (the error's name only)
 * and answers the user `provider_error` — never the IdP's details. Each
 * call is cut off after 15 s.
 */
export interface AuthProvider<Config = any> {
  /** `AUTH_PROVIDER_ID_RE`, not `email`; unique within the slot. The `:provider` of the callback URL and the key of `auth.providers`. */
  id: string;
  /** What `<LoginGate>` shows: "Continue with <label>" (1–40 characters). */
  label: string;
  /**
   * The per-app config of the provider (`auth.providers.<id>`), a zod OBJECT
   * schema (`z.object` / `z.strictObject`) without an `enabled` key — `auth`
   * adds `enabled: boolean`. While disabled, every field is optional; enabling
   * the provider validates the whole schema.
   */
  configSchema: ZodType<Config>;
  /** Defaults merged under the app's config (optional; must pass `configSchema.partial()`). */
  configDefaults?: Partial<Config>;
  /**
   * Config keys that decide WHO can sign in (e.g. `issuer`, `clientId`):
   * changing one while the provider is enabled — and enabling it — waits for
   * the app owner's confirmation.
   */
  identityFields?: string[];
  secrets?: AuthProviderSecretDoc[];
  begin(input: AuthProviderBeginInput<Config>): Promise<AuthProviderBeginResult>;
  callback(input: AuthProviderCallbackInput<Config>): Promise<AuthIdentity>;
}

/** What an `auth.signedIn` observer gets after a successful sign-in (e-mail code or provider). */
export interface AuthSignInEvent {
  app: HookApp;
  /** The signed-in user with the role they got (and the provider's display name, if any). */
  user: EndUser & { name?: string };
  /** `email` (the e-mail code) or the provider id. */
  provider: string;
  /** The first sign-in of this user to the app. */
  isNew: boolean;
  db: DB;
  log: Logger;
}

/** An observer of successful sign-ins (the `auth.signedIn` slot): run after the session exists, cut off after 5 s, errors logged. */
export interface AuthSignedInObserver {
  /** Names the observer in logs (unique within the slot). */
  id: string;
  onSignIn(event: AuthSignInEvent): Promise<void> | void;
}

/** Type a provider contribution (identity at run time). */
export function defineAuthProvider<Config>(provider: AuthProvider<Config>): AuthProvider<Config> {
  return provider;
}

/** Type a sign-in observer contribution (identity at run time). */
export function defineSignInObserver(observer: AuthSignedInObserver): AuthSignedInObserver {
  return observer;
}

// ── the slot schemas (auth declares them; a provider module may self-check with them) ──

const fn = <T>(what: string) => z.custom<T>((v) => typeof v === 'function', `${what} must be a function`);

/** A zod object schema (duck-typed: one zod instance is shared with modules, but keep it tolerant). */
function isObjectSchema(v: unknown): v is z.ZodObject {
  const s = v as { safeParse?: unknown; partial?: unknown; extend?: unknown; shape?: unknown } | null;
  return (
    typeof s === 'object' &&
    s !== null &&
    typeof s.safeParse === 'function' &&
    typeof s.partial === 'function' &&
    typeof s.extend === 'function' &&
    typeof s.shape === 'object' &&
    s.shape !== null
  );
}

const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;

/** The `auth.provider` slot's schema (the contribution as `auth` gets it; unknown keys kept). */
export const authProviderSchema = z
  .looseObject({
    id: z
      .string()
      .regex(AUTH_PROVIDER_ID_RE, 'id must be 2–16 lowercase letters and digits, starting with a letter')
      .refine((id) => id !== EMAIL_PROVIDER_ID, 'id "email" is the e-mail code — pick another'),
    label: z.string().min(1).max(40).refine((l) => !CONTROL.test(l) && l.trim() === l, 'label must be one trimmed line'),
    configSchema: z.custom<z.ZodObject>(isObjectSchema, 'configSchema must be a zod object schema (z.object / z.strictObject)'),
    configDefaults: z.record(z.string(), z.unknown()).optional(),
    identityFields: z.array(z.string().min(1)).max(20).optional(),
    secrets: z
      .array(
        z.object({
          name: z.string(),
          description: z.string().min(1),
          required: z.boolean().optional(),
          env: z.string().optional(),
        })
      )
      .max(20)
      .optional(),
    begin: fn<AuthProvider['begin']>('begin'),
    callback: fn<AuthProvider['callback']>('callback'),
  })
  .superRefine((p, ctx) => {
    if (!AUTH_PROVIDER_ID_RE.test(p.id) || !isObjectSchema(p.configSchema)) return;
    const shape = p.configSchema.shape as Record<string, unknown>;
    if ('enabled' in shape) ctx.addIssue({ code: 'custom', path: ['configSchema'], message: 'configSchema may not declare `enabled` (auth adds it)' });
    for (const f of p.identityFields ?? []) {
      if (!(f in shape)) ctx.addIssue({ code: 'custom', path: ['identityFields'], message: `identityFields names "${f}", which configSchema does not declare` });
    }
    const upper = p.id.toUpperCase();
    const names = new Set<string>();
    for (const s of p.secrets ?? []) {
      if (!SECRET_NAME.test(s.name) || !s.name.startsWith(`${upper}_`)) {
        ctx.addIssue({ code: 'custom', path: ['secrets'], message: `secret "${s.name}" must be UPPER_SNAKE and start with "${upper}_"` });
      }
      if (names.has(s.name)) ctx.addIssue({ code: 'custom', path: ['secrets'], message: `secret "${s.name}" is declared twice` });
      names.add(s.name);
      if (s.env !== undefined && !(SECRET_NAME.test(s.env) && s.env.startsWith(`AUTH_${upper}_`))) {
        ctx.addIssue({ code: 'custom', path: ['secrets'], message: `secret "${s.name}": env must be an AUTH_${upper}_… variable` });
      }
    }
    if (p.configDefaults !== undefined) {
      const r = p.configSchema.partial().safeParse(p.configDefaults);
      if (!r.success) ctx.addIssue({ code: 'custom', path: ['configDefaults'], message: 'configDefaults do not pass configSchema.partial()' });
    }
  }) as unknown as ZodType<AuthProvider>;

/** The `auth.signedIn` slot's schema. */
export const authSignedInObserverSchema = z.looseObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, 'id must be 2–40 lowercase letters, digits or dashes'),
  onSignIn: fn<AuthSignedInObserver['onSignIn']>('onSignIn'),
}) as unknown as ZodType<AuthSignedInObserver>;

/** What `auth` accepts from `callback()` (the address normalized to lower case). */
export const authIdentitySchema = z.object({
  subject: z.string().min(1).max(255).refine((s) => !CONTROL.test(s), 'subject may not contain control characters'),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email({ message: 'must be an e-mail address' })),
  emailVerified: z.boolean(),
  name: z.string().max(200).optional(),
});
