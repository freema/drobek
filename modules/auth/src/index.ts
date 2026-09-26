/**
 * drobek-module-auth — the BUILT-IN platform module `auth` (M1-02, §5.1):
 * end users of an app sign in with a one-time code sent to their e-mail.
 *
 *   DROBEK_MODULES=auth   → this package (`modules/auth` in the drobek repo,
 *                           a dependency of the server).
 *
 *   /__drobek/v1/auth/send-code | verify | me | logout | providers | begin | complete
 *   drobek.auth.me() / sendCode() / verify() / logout() / onChange() / providers() / signIn()
 *   import { LoginGate, useAuth } from 'drobek/auth'   (React, compiled into the app)
 *   config { allow: { emails, domains, anyone }, adminEmails, providers } —
 *   anyone:true, enabling a provider and changing its identity fields need
 *   the owner's confirmation.
 *
 * Sign-in providers (NSO-348): other modules contribute to the slot
 * `auth.provider` (OIDC, SAML, …) — they only prove an identity; this module
 * keeps the allowlist, roles, users and sessions (flow.ts). The IdP calls
 * back on the DASHBOARD host (`endUsers.callback`); a one-time handoff code
 * carries the result to the app host. `auth.signedIn` observers hear about
 * every successful sign-in.
 *
 * Signed-in users are the `user` / `admin` principals every other module
 * reads from `ctx.principal`. This module OWNS end-user sessions
 * (`endUsers`): core asks it on every module request that carries a session
 * who the user is now, so a disabled / removed user is anonymous everywhere
 * at once, and a role change applies on the next request.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  authProviderSchema,
  authSignedInObserverSchema,
  defineModule,
  type AuthProvider,
  type ModuleErrorDoc,
} from '@drobek/modules';
import { AUTH_CONFIG_DEFAULTS, authConfigSchema, authConfirmRequired, composeAuthConfig, type AuthConfig } from './config.js';
import { currentUser } from './current.js';
import { CALLBACK_LIMIT, providerCallback } from './flow.js';
import { ownerMethods } from './owner.js';
import { PROVIDER_SLOT, SIGNED_IN_SLOT } from './providers.js';
import { registerRoutes } from './routes.js';

export {
  AUTH_CONFIG_DEFAULTS,
  EMAIL_CODE_KEY,
  authConfigSchema,
  authConfirmRequired,
  composeAuthConfig,
  confirmRequiredFor,
  decideSignIn,
  methodEnabled,
  type AuthConfig,
  type ProviderEntry,
} from './config.js';
export { currentUser } from './current.js';
export { COMPLETE_PATH, HANDOFF_TTL_SEC, STATE_TTL_SEC, callbackUrl, flowCookieName, handoffKey, stateKey, stateSecret } from './flow.js';
export { OBSERVER_TIMEOUT_MS, PROVIDER_CALL_TIMEOUT_MS, PROVIDER_SLOT, SIGNED_IN_SLOT, notifySignedIn, signInMethods, type SignInMethod } from './providers.js';
export { providerSignIn, type ProviderSignIn } from './users.js';
export { endUserRecord, ownerMethods, workspaceEditorEmails } from './owner.js';
export { otpScope, safeName, signInEmail, type PublicUser } from './routes.js';
export { authUsers, type AuthUserRow } from './schema.js';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** The SDK entry next to this file: dist/sdk.js when built, src/sdk.ts in a source checkout. */
const sdkEntry = existsSync(here('./sdk.js')) ? here('./sdk.js') : here('./sdk.ts');

export const SDK_TYPES = `
export interface User {
  id: string;
  email: string;
  role: 'user' | 'admin';
}
export interface SignInMethod {
  /** 'emailCode' (the e-mail code form) or a sign-in provider id for signIn(). */
  id: string;
  /** e.g. "E-mail code", "Company SSO" — show "Continue with <label>". */
  label: string;
}
export interface Api {
  /** The signed-in user of THIS host, or null. Also extends the 30-day session. */
  me(): Promise<User | null>;
  /** E-mail a 6-digit code (valid 10 minutes). Rejects: email_not_allowed (403), rate_limited (429), provider_not_enabled (404, e-mail code off). */
  sendCode(email: string): Promise<{ sent: true; email: string; expires_in: number }>;
  /** Code → session cookie. Rejects: invalid_code (400), too_many_attempts (429), email_not_allowed (403). */
  verify(email: string, code: string): Promise<User>;
  logout(): Promise<void>;
  /** Called when me/verify/logout change the user; returns the unsubscribe function. */
  onChange(listener: (user: User | null) => void): () => void;
  /** The sign-in methods that are on for this app: 'emailCode' first when on, then the providers. */
  providers(): Promise<SignInMethod[]>;
  /**
   * Leave the page to sign in with a provider (its IdP); the browser comes back
   * signed in to returnTo (a path on this host, default: the current page).
   * Rejects (before leaving): provider_not_enabled (404), provider_error (502), rate_limited (429).
   */
  signIn(provider: string, options?: { returnTo?: string }): Promise<void>;
}
`;

export const INLINE_TYPES = `
import type { JSX, ReactNode } from 'react';
export interface User { id: string; email: string; role: 'user' | 'admin' }
export interface LoginGateProps {
  /** What signed-in users see; a function gets the user. */
  children: ReactNode | ((user: User) => ReactNode);
  /** Heading of the sign-in form (default "Sign in"). Shows the e-mail form and/or "Continue with <label>" per enabled provider. */
  title?: string;
  /** Only admins get through; other signed-in users see "no access" and a sign-out button. */
  requireAdmin?: boolean;
  /** Shown while the session is checked (default: nothing). */
  loading?: ReactNode;
}
export function LoginGate(props: LoginGateProps): JSX.Element;
export function useAuth(): { user: User | null; loading: boolean; error: string | null; logout(): Promise<void>; refresh(): Promise<void> };
`;

/** The module's own error codes (skill_info('auth').errors, the auth section of the error catalogue). */
const AUTH_ERRORS: ModuleErrorDoc[] = [
  {
    code: 'email_not_allowed',
    meaning: "HTTP 403. The address may not sign in to this app: it is not in `allow` / `adminEmails` of the auth config, or the user is disabled. No code was sent.",
    fix: "Add the address or its domain with configure_module('auth'), or tell the user who may sign in.",
  },
  {
    code: 'invalid_code',
    meaning: "HTTP 400. The sign-in code is wrong, expired (10 minutes) or already used.",
    fix: "Re-enter the code from the e-mail, or request a new one with drobek.auth.sendCode.",
  },
  {
    code: 'too_many_attempts',
    meaning: "HTTP 429. Five wrong codes were entered for this address; the code is dead.",
    fix: "Request a new code (drobek.auth.sendCode); <LoginGate> goes back to the e-mail step by itself.",
  },
  {
    code: 'provider_not_enabled',
    meaning: "HTTP 404. The sign-in method is off for this app: drobek.auth.signIn(id) names a provider that is not enabled in the auth config (or not installed on this server), or sendCode/verify ran while providers.emailCode.enabled is false.",
    fix: "Call drobek.auth.providers() and offer only what it lists (<LoginGate> does), or enable the method with configure_module('auth', { providers: { <id>: { enabled: true } } }).",
  },
  {
    code: 'provider_error',
    meaning: "HTTP 502. The sign-in provider failed (its IdP was unreachable, misconfigured, or answered no usable identity). The details are in the server log, never in the answer.",
    fix: "Try again; if it keeps failing, the app owner checks the provider's config and secrets in the dashboard (get_logs shows only that it failed).",
  },
  {
    code: 'email_not_verified',
    meaning: "HTTP 403 (a page on the dashboard host). The provider did not confirm the person's e-mail address, and every sign-in decision (allowlist, adminEmails) is made by the address.",
    fix: "The person verifies their address at the identity provider; the operator may tell the provider to trust its addresses (e.g. the oidc provider's trustEmail).",
  },
  {
    code: 'invalid_state',
    meaning: "HTTP 400 (a page). A provider sign-in link expired (10 minutes to sign in at the IdP, 60 seconds to come back), was already used, came from another app host, or reached a browser that did not start it.",
    fix: "Start the sign-in again from the app (drobek.auth.signIn / <LoginGate>) in the same browser.",
  },
];

const auth = defineModule<AuthConfig>({
  name: 'auth',
  version: '1.0.0',
  contract: '^1.1',
  errors: AUTH_ERRORS,
  skill: {
    useWhen: 'people must sign in to the app (only some e-mails or a company domain, admins, per-user data)',
    markdown: readFileSync(here('../SKILL.md'), 'utf8'),
  },
  configSchema: authConfigSchema,
  configDefaults: AUTH_CONFIG_DEFAULTS,
  confirmRequired: authConfirmRequired,
  slots: {
    [PROVIDER_SLOT]: {
      schema: authProviderSchema,
      unique: 'id',
      description:
        'A way for end users to sign in besides the e-mail code (OIDC, SAML, …): begin() → the IdP URL, callback() → the verified identity { subject, email, emailVerified, name? }. auth keeps the allowlist, roles, users and the session.',
    },
    [SIGNED_IN_SLOT]: {
      schema: authSignedInObserverSchema,
      unique: 'id',
      description: 'Told about every successful end-user sign-in (e.g. a CRM sync): onSignIn({ app, user, provider, isNew, db, log }); cut off after 5 s, errors logged, never blocks.',
    },
  },
  // The providers' config (`providers.<id>`), confirm rules and secrets.
  compose: ({ contributions }) => {
    const providers = contributions<AuthProvider>(PROVIDER_SLOT);
    return { ...composeAuthConfig(providers), secrets: providers.flatMap((p) => (p.secrets ?? []).map(({ name, description, required }) => ({ name, description, required }))) };
  },
  rules: {
    ops: {
      sign_in: 'Send a code to an allowed e-mail and exchange it for a session (always public; the allowlist decides)',
    },
  },
  limits: [
    { env: 'AUTH_CODES_PER_IP_15MIN', default: 5, meaning: 'sign-in codes one visitor IP may request per 15 minutes' },
    { env: 'AUTH_CODES_PER_IP_DAY', default: 20, meaning: 'sign-in codes one visitor IP may request per day' },
    { env: 'AUTH_CODES_PER_EMAIL_HOUR', default: 3, meaning: 'sign-in codes one e-mail address gets per hour (more requests send nothing new)' },
    {
      env: 'AUTH_CODES_PER_APP_HOUR',
      default: 100,
      meaning: 'sign-in codes the whole app may send per hour; past it sign-in e-mails pause for 15 minutes',
    },
    { env: 'AUTH_ATTEMPTS_PER_IP_15MIN', default: 30, meaning: 'send-code, verify, begin and complete calls one visitor IP may make per 15 minutes' },
    {
      env: CALLBACK_LIMIT,
      default: 60,
      meaning: 'sign-in provider callbacks one client IP may make per 15 minutes on the dashboard host (a server-wide value: the app is not known yet)',
    },
    { env: 'END_USERS_MAX_PER_APP', default: 1000, meaning: 'end users one app may have' },
  ],
  routes: registerRoutes,
  endUsers: {
    current: async ({ app, user, config, db }) => (await currentUser(db, app, config, user.id, user.provider ?? 'email'))?.user ?? null,
    // The sign-in providers' IdP callback on the dashboard host (flow.ts).
    callback: providerCallback,
    // The owner's view (the dashboard Users tab): list, role, block.
    ...ownerMethods,
  },
  sdk: {
    entry: sdkEntry,
    types: SDK_TYPES,
    inline: { entry: here('../sdk/auth.tsx'), types: INLINE_TYPES },
  },
  migrations: { folder: here('../migrations') },
});

export default auth;
