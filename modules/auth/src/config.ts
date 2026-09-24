/**
 * The auth module's per-app config and the pure access decision (who may sign
 * in, with which role). Set by agents through `configure_module('auth', …)`;
 * opening sign-in to anyone needs the app owner's confirmation.
 */
import { z } from '@drobek/modules';

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const email = z.string().trim().toLowerCase().max(254).pipe(z.email({ message: 'must be an e-mail address' }));
const domain = z.string().trim().toLowerCase().regex(DOMAIN_RE, 'must be a domain like example.com (no @, no scheme)');

export const authConfigSchema = z.strictObject({
  allow: z.strictObject({
    /** Exact addresses that may sign in (case-insensitive). */
    emails: z.array(email).max(500),
    /** Every address at these domains may sign in (exact domain, no subdomains). */
    domains: z.array(domain).max(50),
    /** Anyone with an e-mail address may sign in (needs the owner's confirmation). */
    anyone: z.boolean(),
  }),
  /** These addresses may sign in and are `admin`. */
  adminEmails: z.array(email).max(50),
});

export type AuthConfig = z.infer<typeof authConfigSchema>;

export const AUTH_CONFIG_DEFAULTS: AuthConfig = {
  allow: { emails: [], domains: [], anyone: false },
  adminEmails: [],
};

/** Opening sign-in to anyone waits for the owner (§5.0). */
export function authConfirmRequired(before: AuthConfig, after: AuthConfig): string[] {
  if (!before.allow.anyone && after.allow.anyone) {
    return ['allow.anyone: false → true (anyone with an e-mail address can sign in to this app)'];
  }
  return [];
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1);
}

export interface AccessInput {
  config: AuthConfig;
  /** Normalized (trimmed, lowercase). */
  email: string;
  /** Is the address an editor (or workspace-admin) of the app's workspace? */
  workspaceEditor: boolean;
}

export type AccessResult = { allowed: false } | { allowed: true; role: 'user' | 'admin' };

/**
 * May `email` sign in, and as what?
 *  - admin: listed in `adminEmails`, or an editor of the app's workspace
 *    (the people who build the app can always sign in to it);
 *  - user: `allow.anyone`, listed in `allow.emails`, or at a domain of
 *    `allow.domains`;
 *  - nobody else.
 */
export function decideSignIn(input: AccessInput): AccessResult {
  const { config, email } = input;
  if (input.workspaceEditor || config.adminEmails.includes(email)) return { allowed: true, role: 'admin' };
  if (config.allow.anyone || config.allow.emails.includes(email) || config.allow.domains.includes(domainOf(email))) {
    return { allowed: true, role: 'user' };
  }
  return { allowed: false };
}
