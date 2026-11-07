/**
 * The personal instance: path routing (APPS_ROUTING_MODE=path) puts every app
 * on one browser origin, which isolates no app from another, so such a server
 * belongs to ONE trusted owner — the single address in SUPERADMIN_EMAIL —
 * and nobody else gets an account on it. Enforced on the server, not only
 * documented:
 *  - the start is refused without exactly one SUPERADMIN_EMAIL address
 *    (`personalInstanceConfigError`), and while the database holds an account
 *    of any other address (`personalAccountsError`);
 *  - no sign-in code is sent to another address and no `users` row is created
 *    for one (`mayHoldAccount`, checked by the login routes,
 *    `ensureUserByEmail` and the Google sign-in);
 *  - workspace invites, joining by an invite link and changing the account's
 *    address are refused (@drobek/tenancy, the dashboard), so the owner stays
 *    the only member of every workspace.
 * App end users (the auth module's own users of the owner's apps) are not
 * drobek accounts and are not affected.
 */
import { ne } from 'drizzle-orm';
import { pathRouting } from '@drobek/apps';
import { getDb, users } from '@drobek/db';
import { superAdminEmails } from './super-admin.server.js';

/** True on a personal instance (path routing). An invalid apps config counts as not personal — the start refuses it anyway. */
export function personalInstance(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return pathRouting(env);
  } catch {
    return false;
  }
}

/** The owner's address on a personal instance, else null. */
export function personalOwnerEmail(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!personalInstance(env)) return null;
  const owners = superAdminEmails(env.SUPERADMIN_EMAIL);
  return owners.length === 1 ? owners[0] : null;
}

/** May `email` (normalized) hold a drobek account here? Always on a shared instance; only the owner's on a personal one. */
export function mayHoldAccount(email: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!personalInstance(env)) return true;
  const owner = personalOwnerEmail(env);
  return owner !== null && email.trim().toLowerCase() === owner;
}

/** The error a refused personal-instance action answers with. */
export class PersonalInstanceError extends Error {
  readonly code = 'personal_instance';
  constructor(message = 'This drobek server is a personal instance: only its owner has an account here.') {
    super(message);
    this.name = 'PersonalInstanceError';
  }
}

/** Startup check: path routing needs exactly one SUPERADMIN_EMAIL address (the owner). */
export function personalInstanceConfigError(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!personalInstance(env)) return null;
  const owners = superAdminEmails(env.SUPERADMIN_EMAIL);
  if (owners.length !== 1) {
    return 'drobek refuses to start: APPS_ROUTING_MODE=path makes a personal instance and needs exactly one SUPERADMIN_EMAIL address (its owner).';
  }
  return null;
}

/** Startup check against the database: no account other than the owner's may exist on a personal instance. */
export async function personalAccountsError(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const owner = personalOwnerEmail(env);
  if (!personalInstance(env) || owner === null) return null;
  const [other] = await getDb().select({ id: users.id }).from(users).where(ne(users.email, owner)).limit(1);
  return other
    ? 'drobek refuses to start: APPS_ROUTING_MODE=path makes a personal instance, but the database holds an account of another address than SUPERADMIN_EMAIL. Use subdomain routing for a shared server.'
    : null;
}
