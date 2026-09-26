/**
 * The OWNER's view of an app's end users (the optional owner methods of the
 * `endUsers` authority — the dashboard Users tab, M2-03). Core calls them only
 * after it authorized a drobek account for the app; every query is scoped to
 * the ONE app of the view.
 *
 * The role of an end user FOLLOWS THE CONFIG (see current.ts), so changing it
 * is a config change: `admin` adds the address to `adminEmails`; `user`
 * removes it — and adds it to `allow.emails` when nothing else would still
 * let the address in, so a demoted admin stays a user instead of being
 * locked out. Core applies the patch under the config lock; the next module
 * request already sees the new role. An editor of the app's workspace is
 * always admin (their access comes from the workspace, not the config).
 *
 * Blocking sets `disabled_at`: `current` answers null from the next request,
 * so core ends the user's sessions on every host; unblocking clears it (the
 * user signs in again with a new code).
 */
import { and, count, desc, eq, ilike, inArray, lt, or, type SQL } from 'drizzle-orm';
import { memberships, users, type DB } from '@drobek/db';
import { ModuleError, type EndUserRecord, type EndUserAuthority } from '@drobek/modules';
import { decideSignIn, domainOf, methodEnabled, type AuthConfig } from './config.js';
import { authUsers, type AuthUserRow } from './schema.js';
import { findUserById } from './users.js';

type OwnerMethods = Required<Pick<EndUserAuthority<AuthConfig>, 'list' | 'setRole' | 'setDisabled'>>;

const MAX_PAGE = 100;
const DEFAULT_PAGE = 50;
const MAX_ADMIN_EMAILS = 50;
const MAX_ALLOW_EMAILS = 500;
const USER_ID_RE = /^eu_[0-9a-f]{24}$/;

/** The addresses of the editors + workspace-admins of a workspace (always admins of its apps). */
export async function workspaceEditorEmails(db: DB, workspaceId: string): Promise<Set<string>> {
  const rows = await db
    .select({ email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.workspaceId, workspaceId), inArray(memberships.role, ['editor', 'workspace-admin'])));
  return new Set(rows.map((r) => r.email.toLowerCase()));
}

/**
 * Can the account still sign in by some method that is on — the provider it
 * is linked to, or the e-mail code (which proves the address, so any
 * account may use it)?
 */
function canSignIn(row: Pick<AuthUserRow, 'provider'>, config: AuthConfig): boolean {
  return methodEnabled(config, 'email') || methodEnabled(config, row.provider);
}

/** One user as the owner sees them, under `config` (the same decision as `current`). */
export function endUserRecord(row: AuthUserRow, config: AuthConfig, workspaceEditor: boolean): EndUserRecord {
  const access = decideSignIn({ config, email: row.email, workspaceEditor });
  const role = access.allowed ? access.role : row.role;
  return {
    id: row.id,
    email: row.email,
    role,
    roleSource: role !== 'admin' ? null : workspaceEditor ? 'workspace' : 'config',
    status: row.disabledAt ? 'disabled' : access.allowed && canSignIn(row, config) ? 'active' : 'not_allowed',
    provider: row.provider,
    created_at: row.createdAt.toISOString(),
    last_sign_in_at: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
  };
}

function encodeCursor(row: Pick<AuthUserRow, 'createdAt' | 'id'>): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): { createdAt: Date; id: string } | null {
  const [iso, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(iso ?? '');
  if (!id || !USER_ID_RE.test(id) || Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id };
}

async function requireUser(db: DB, appId: string, id: string): Promise<AuthUserRow> {
  const row = USER_ID_RE.test(id) ? await findUserById(db, appId, id) : null;
  if (!row) throw new ModuleError('not_found', 'No such user of this app.');
  return row;
}

/** Would `email` still get in as a plain user without being an admin? */
function allowedAsUser(config: AuthConfig, email: string): boolean {
  return config.allow.anyone || config.allow.emails.includes(email) || config.allow.domains.includes(domainOf(email));
}

export const ownerMethods: OwnerMethods = {
  async list(view, q) {
    const conds: SQL[] = [eq(authUsers.appId, view.app.id)];
    const search = q.search?.trim().toLowerCase().slice(0, 254);
    if (search) conds.push(ilike(authUsers.email, `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
    const where = and(...conds)!;
    const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(q.limit ?? DEFAULT_PAGE)) || DEFAULT_PAGE));
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    if (q.cursor && !cursor) throw new ModuleError('invalid_request', 'The cursor is not valid — use next_cursor of the previous page.');
    const page = cursor
      ? and(where, or(lt(authUsers.createdAt, cursor.createdAt), and(eq(authUsers.createdAt, cursor.createdAt), lt(authUsers.id, cursor.id))))
      : where;
    const rows = await view.db.select().from(authUsers).where(page).orderBy(desc(authUsers.createdAt), desc(authUsers.id)).limit(limit + 1);
    const [total] = await view.db.select({ n: count() }).from(authUsers).where(where);
    const editors = await workspaceEditorEmails(view.db, view.app.workspaceId);
    const shown = rows.slice(0, limit);
    return {
      users: shown.map((row) => endUserRecord(row, view.config, editors.has(row.email))),
      total: Number(total?.n ?? 0),
      next_cursor: rows.length > limit ? encodeCursor(shown[shown.length - 1]) : null,
    };
  },

  async setRole(view, id, role) {
    const row = await requireUser(view.db, view.app.id, id);
    const config = view.config;
    const editor = (await workspaceEditorEmails(view.db, view.app.workspaceId)).has(row.email);
    if (editor && role === 'user') {
      throw new ModuleError('conflict', `${row.email} is an editor of this app's workspace and is always an admin of its apps — change their workspace role instead.`, {
        details: { reason: 'workspace_editor' },
      });
    }
    let next: AuthConfig = config;
    let configPatch: Record<string, unknown> | null = null;
    if (role === 'admin' && !editor && !config.adminEmails.includes(row.email)) {
      if (config.adminEmails.length >= MAX_ADMIN_EMAILS) {
        throw new ModuleError('conflict', `An app can have at most ${MAX_ADMIN_EMAILS} admin addresses.`, { details: { reason: 'too_many_admins' } });
      }
      const adminEmails = [...config.adminEmails, row.email];
      next = { ...config, adminEmails };
      configPatch = { adminEmails };
    } else if (role === 'user' && config.adminEmails.includes(row.email)) {
      const adminEmails = config.adminEmails.filter((e) => e !== row.email);
      next = { ...config, adminEmails };
      configPatch = { adminEmails };
      if (!allowedAsUser(config, row.email)) {
        if (config.allow.emails.length >= MAX_ALLOW_EMAILS) {
          throw new ModuleError('conflict', `The allowlist already holds ${MAX_ALLOW_EMAILS} addresses.`, { details: { reason: 'allowlist_full' } });
        }
        const emails = [...config.allow.emails, row.email];
        next = { ...next, allow: { ...config.allow, emails } };
        configPatch = { adminEmails, allow: { emails } };
      }
    }
    await view.db.update(authUsers).set({ role }).where(and(eq(authUsers.appId, view.app.id), eq(authUsers.id, row.id)));
    return { user: endUserRecord({ ...row, role }, next, editor), configPatch };
  },

  async setDisabled(view, id, disabled) {
    if (!USER_ID_RE.test(id)) return null;
    const [row] = await view.db
      .update(authUsers)
      .set({ disabledAt: disabled ? new Date() : null })
      .where(and(eq(authUsers.appId, view.app.id), eq(authUsers.id, id)))
      .returning();
    if (!row) return null;
    const editor = (await workspaceEditorEmails(view.db, view.app.workspaceId)).has(row.email);
    return endUserRecord(row, view.config, editor);
  },
};
