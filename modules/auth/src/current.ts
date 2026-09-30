/**
 * Who a signed-in end user of an app is NOW — the one decision behind both
 * the core principal of every module request (`endUsers.current`, called by
 * core for each request that carries a live session) and this module's `me`:
 *
 *   - the `mod_auth_users` row still exists and is not disabled;
 *   - the sign-in method of the SESSION (`email` = the e-mail code, or the
 *     auth provider it came from) is still on in the app's config — turning
 *     a provider off (or the e-mail code) signs its sessions out;
 *   - a provider session: the provider is still contributed by a module that
 *     is on for the app's workspace, and its connection (identity config +
 *     env fallbacks) is the one the session began under — changing whose
 *     accounts it admits signs its sessions out;
 *   - the app's CURRENT config still lets the address in (allowlist,
 *     adminEmails, or an editor of the app's workspace);
 *   - the role follows the config (adminEmails / workspace editor → admin).
 *
 * Two indexed lookups (the row by primary key, the editor membership); no
 * cache, so disabling a user, deleting them, removing them from the
 * allowlist or from adminEmails, or removing an editor from the workspace
 * takes effect on the next request to any module.
 */
import type { DB } from '@drobek/db';
import type { EndUser, HookApp } from '@drobek/modules';
import { decideSignIn, methodEnabled, type AuthConfig } from './config.js';
import { connectionOf, enabledProvider } from './providers.js';
import type { AuthUserRow } from './schema.js';
import { findUserById, isWorkspaceEditor } from './users.js';

/** What a session (or a sign-in about to become one) says about itself. */
export interface SessionClaim {
  id: string;
  /** How the session signed in (`email` or a provider id); sessions from before providers are `email`. */
  provider?: string;
  /** A provider session's connection (see connectionOf). */
  connection?: string;
}

type Contributions = <T = unknown>(slot: string) => T[];

export async function currentUser(
  db: DB,
  app: Pick<HookApp, 'id' | 'workspaceId'>,
  config: AuthConfig,
  session: SessionClaim,
  contributions: Contributions
): Promise<{ row: AuthUserRow; user: EndUser } | null> {
  const method = session.provider ?? 'email';
  if (!methodEnabled(config, method)) return null;
  if (method !== 'email') {
    const provider = enabledProvider(contributions, config, method);
    if (!provider || session.connection === undefined || session.connection !== connectionOf(provider, config)) return null;
  }
  const row = await findUserById(db, app.id, session.id);
  if (!row || row.disabledAt) return null;
  const workspaceEditor = await isWorkspaceEditor(db, app.workspaceId, row.email);
  const access = decideSignIn({ config, email: row.email, workspaceEditor });
  if (!access.allowed) return null;
  return { row, user: { id: row.id, email: row.email, role: access.role } };
}
