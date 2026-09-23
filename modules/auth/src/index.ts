/**
 * drobek-module-auth — the BUILT-IN platform module `auth` (M1-02, §5.1):
 * end users of an app sign in with a one-time code sent to their e-mail.
 *
 *   DROBEK_MODULES=auth   → this package (`modules/auth` in the drobek repo,
 *                           a dependency of the server).
 *
 *   /__drobek/v1/auth/send-code | verify | me | logout
 *   drobek.auth.me() / sendCode() / verify() / logout() / onChange()
 *   import { LoginGate, useAuth } from 'drobek/auth'   (React, compiled into the app)
 *   config { allow: { emails, domains, anyone }, adminEmails } — anyone:true
 *   needs the owner's confirmation.
 *
 * Signed-in users are the `user` / `admin` principals every other module
 * reads from `ctx.principal`. This module OWNS end-user sessions
 * (`endUsers`): core asks it on every module request that carries a session
 * who the user is now, so a disabled / removed user is anonymous everywhere
 * at once, and a role change applies on the next request.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineModule } from '@drobek/modules';
import { AUTH_CONFIG_DEFAULTS, authConfigSchema, authConfirmRequired, type AuthConfig } from './config.js';
import { currentUser } from './current.js';
import { registerRoutes } from './routes.js';

export { AUTH_CONFIG_DEFAULTS, authConfigSchema, authConfirmRequired, decideSignIn, type AuthConfig } from './config.js';
export { currentUser } from './current.js';
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
export interface Api {
  /** The signed-in user of THIS host, or null. Also extends the 30-day session. */
  me(): Promise<User | null>;
  /** E-mail a 6-digit code (valid 10 minutes). Rejects: email_not_allowed (403), rate_limited (429). */
  sendCode(email: string): Promise<{ sent: true; email: string; expires_in: number }>;
  /** Code → session cookie. Rejects: invalid_code (400), too_many_attempts (429), email_not_allowed (403). */
  verify(email: string, code: string): Promise<User>;
  logout(): Promise<void>;
  /** Called when me/verify/logout change the user; returns the unsubscribe function. */
  onChange(listener: (user: User | null) => void): () => void;
}
`;

export const INLINE_TYPES = `
import type { ReactNode } from 'react';
export interface User { id: string; email: string; role: 'user' | 'admin' }
export interface LoginGateProps {
  /** What signed-in users see; a function gets the user. */
  children: ReactNode | ((user: User) => ReactNode);
  /** Heading of the sign-in form (default "Sign in"). */
  title?: string;
  /** Only admins get through; other signed-in users see "no access" and a sign-out button. */
  requireAdmin?: boolean;
  /** Shown while the session is checked (default: nothing). */
  loading?: ReactNode;
}
export function LoginGate(props: LoginGateProps): JSX.Element;
export function useAuth(): { user: User | null; loading: boolean; logout(): Promise<void>; refresh(): Promise<void> };
`;

const auth = defineModule<AuthConfig>({
  name: 'auth',
  version: '1.0.0',
  skill: {
    useWhen: 'people must sign in to the app (only some e-mails or a company domain, admins, per-user data)',
    markdown: readFileSync(here('../SKILL.md'), 'utf8'),
  },
  configSchema: authConfigSchema,
  configDefaults: AUTH_CONFIG_DEFAULTS,
  confirmRequired: authConfirmRequired,
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
    { env: 'AUTH_ATTEMPTS_PER_IP_15MIN', default: 30, meaning: 'send-code + verify calls one visitor IP may make per 15 minutes' },
    { env: 'END_USERS_MAX_PER_APP', default: 1000, meaning: 'end users one app may have' },
  ],
  routes: registerRoutes,
  endUsers: {
    current: async ({ app, user, config, db }) => (await currentUser(db, app, config, user.id))?.user ?? null,
  },
  sdk: {
    entry: sdkEntry,
    types: SDK_TYPES,
    inline: { entry: here('../sdk/auth.tsx'), types: INLINE_TYPES },
  },
  migrations: { folder: here('../migrations') },
});

export default auth;
