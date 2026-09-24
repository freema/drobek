/**
 * `mod_auth_users` and the few core lookups the sign-in needs. Every query is
 * filtered by the app id the runtime scoped the context to.
 */
import { randomBytes } from 'node:crypto';
import { and, count, eq, inArray } from 'drizzle-orm';
import { apps, memberships, users, type DB } from '@drobek/db';
import { authUsers, type AuthUserRow } from './schema.js';

function newUserId(): string {
  return `eu_${randomBytes(12).toString('hex')}`;
}

export async function findUserByEmail(db: DB, appId: string, email: string): Promise<AuthUserRow | null> {
  const [row] = await db
    .select()
    .from(authUsers)
    .where(and(eq(authUsers.appId, appId), eq(authUsers.email, email)))
    .limit(1);
  return row ?? null;
}

export async function findUserById(db: DB, appId: string, id: string): Promise<AuthUserRow | null> {
  const [row] = await db
    .select()
    .from(authUsers)
    .where(and(eq(authUsers.appId, appId), eq(authUsers.id, id)))
    .limit(1);
  return row ?? null;
}

export async function countUsers(db: DB, appId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(authUsers).where(eq(authUsers.appId, appId));
  return Number(row?.n ?? 0);
}

/** A successful sign-in: create the row (verified now) or stamp the existing one. */
export async function recordSignIn(db: DB, appId: string, email: string, role: 'user' | 'admin'): Promise<AuthUserRow> {
  const now = new Date();
  const [row] = await db
    .insert(authUsers)
    .values({ id: newUserId(), appId, email, role, verifiedAt: now, lastLoginAt: now })
    .onConflictDoUpdate({
      target: [authUsers.appId, authUsers.email],
      set: { role, lastLoginAt: now },
    })
    .returning();
  return row;
}

export async function setUserRole(db: DB, appId: string, id: string, role: 'user' | 'admin'): Promise<void> {
  await db
    .update(authUsers)
    .set({ role })
    .where(and(eq(authUsers.appId, appId), eq(authUsers.id, id)));
}

/** Is `email` an editor or workspace-admin of `workspaceId`? */
export async function isWorkspaceEditor(db: DB, workspaceId: string, email: string): Promise<boolean> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.workspaceId, workspaceId),
        eq(users.email, email),
        inArray(memberships.role, ['editor', 'workspace-admin'])
      )
    )
    .limit(1);
  return Boolean(row);
}

/** The app's display name for the sign-in e-mail (its name, else the slug). */
export async function appDisplayName(db: DB, appId: string, fallback: string): Promise<string> {
  const [row] = await db.select({ name: apps.name }).from(apps).where(eq(apps.id, appId)).limit(1);
  return row?.name?.trim() || fallback;
}
