/**
 * `mod_auth_users`, `mod_auth_identities` and the few core lookups the
 * sign-in needs. Every query is filtered by the app id the runtime scoped the
 * context to.
 */
import { randomBytes } from 'node:crypto';
import { and, count, eq, inArray, isNull } from 'drizzle-orm';
import { apps, isUniqueViolation, memberships, users, type DB } from '@drobek/db';
import { authIdentities, authUsers, type AuthIdentityRow, type AuthUserRow } from './schema.js';

function newUserId(): string {
  return `eu_${randomBytes(12).toString('hex')}`;
}

function newIdentityId(): string {
  return `ei_${randomBytes(12).toString('hex')}`;
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

// ── provider identities (NSO-360) ────────────────────────────────────────────

/** A provider identity the callback proved (a verified address the allowlist admitted). */
export interface ProviderIdentityInput {
  provider: string;
  issuer: string;
  subject: string;
  email: string;
  role: 'user' | 'admin';
}

export interface ProviderSignInOptions {
  /** END_USERS_MAX_PER_APP. */
  maxUsers: number;
  /**
   * `providers.<id>.relinkByEmail` (owner-confirmed): a user whose only
   * identity is of THIS provider at another issuer (or a pre-issuer one) is
   * moved to the new identity by the verified address — an issuer migration.
   */
  relinkByEmail?: boolean;
}

/** What a provider sign-in did — or why it was refused. */
export type ProviderSignIn =
  | { ok: true; row: AuthUserRow; isNew: boolean; linked: boolean; relinked: boolean; claimed: boolean }
  | { ok: false; reason: 'disabled' | 'linked_elsewhere' | 'email_taken' | 'limit' | 'identity_mismatch' };

type Refusal = Extract<ProviderSignIn, { ok: false }>;
type Outcome = { linked: boolean; relinked: boolean; claimed: boolean };

async function findIdentity(db: DB, appId: string, provider: string, issuer: string, subject: string): Promise<AuthIdentityRow | null> {
  const [row] = await db
    .select()
    .from(authIdentities)
    .where(
      and(
        eq(authIdentities.appId, appId),
        eq(authIdentities.provider, provider),
        eq(authIdentities.issuer, issuer),
        eq(authIdentities.subject, subject)
      )
    )
    .limit(1);
  return row ?? null;
}

async function findLegacyIdentity(db: DB, appId: string, provider: string, subject: string): Promise<AuthIdentityRow | null> {
  const [row] = await db
    .select()
    .from(authIdentities)
    .where(
      and(eq(authIdentities.appId, appId), eq(authIdentities.provider, provider), isNull(authIdentities.issuer), eq(authIdentities.subject, subject))
    )
    .limit(1);
  return row ?? null;
}

/** The identities linked to one user of the app. */
async function identitiesOf(db: DB, appId: string, userId: string): Promise<AuthIdentityRow[]> {
  return db
    .select()
    .from(authIdentities)
    .where(and(eq(authIdentities.appId, appId), eq(authIdentities.userId, userId)));
}

/** The user an identity is bound to signs in: the address follows the IdP (unless another user has it). */
async function signInBound(db: DB, appId: string, identity: AuthIdentityRow, input: ProviderIdentityInput, outcome: Outcome): Promise<ProviderSignIn> {
  const user = await findUserById(db, appId, identity.userId);
  if (!user || user.disabledAt) return { ok: false, reason: 'disabled' };
  if (user.email !== input.email) {
    const other = await findUserByEmail(db, appId, input.email);
    if (other && other.id !== user.id) return { ok: false, reason: 'email_taken' };
  }
  const now = new Date();
  try {
    const [row] = await db
      .update(authUsers)
      .set({ email: input.email, role: input.role, provider: identity.provider, lastLoginAt: now, verifiedAt: user.verifiedAt ?? now })
      .where(and(eq(authUsers.appId, appId), eq(authUsers.id, user.id)))
      .returning();
    await db.update(authIdentities).set({ lastLoginAt: now }).where(eq(authIdentities.id, identity.id));
    return { ok: true, row, isNew: false, ...outcome };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'email_taken' };
    throw err;
  }
}

/**
 * A provider sign-in of a VERIFIED identity the allowlist admitted. The
 * identity is (provider, issuer, subject) — never the subject alone:
 *
 *  1. the identity is bound → its user (the address follows the IdP; refused
 *     when another user of the app has the new one);
 *  2. a pre-issuer identity (0001) of this provider + subject → claimed for
 *     this issuer, only when the IdP asserts the user's own address (else
 *     `identity_mismatch`);
 *  3. a user with this address and NO identity (an e-mail user) → linked;
 *     with `relinkByEmail`, a user whose only identity is of this provider at
 *     another issuer → moved to this identity (an owner-confirmed issuer
 *     migration); any other user with this address → `linked_elsewhere`
 *     (never re-linked by an address alone);
 *  4. else a new user (within `maxUsers`) with this identity.
 * A disabled user is refused in every case. A race (a unique index) starts
 * over once.
 */
export async function providerSignIn(
  db: DB,
  appId: string,
  input: ProviderIdentityInput,
  opts: ProviderSignInOptions,
  retry = true
): Promise<ProviderSignIn> {
  const again = async (fallback: Refusal): Promise<ProviderSignIn> => (retry ? providerSignIn(db, appId, input, opts, false) : fallback);
  const { provider, issuer, subject, email, role } = input;

  const bound = await findIdentity(db, appId, provider, issuer, subject);
  if (bound) return signInBound(db, appId, bound, input, { linked: false, relinked: false, claimed: false });

  const legacy = await findLegacyIdentity(db, appId, provider, subject);
  if (legacy) {
    const owner = await findUserById(db, appId, legacy.userId);
    if (!owner || owner.disabledAt) return { ok: false, reason: 'disabled' };
    if (owner.email !== email) return { ok: false, reason: 'identity_mismatch' };
    try {
      const [claimed] = await db
        .update(authIdentities)
        .set({ issuer })
        .where(and(eq(authIdentities.id, legacy.id), isNull(authIdentities.issuer)))
        .returning();
      if (!claimed) return again({ ok: false, reason: 'identity_mismatch' });
      return signInBound(db, appId, claimed, input, { linked: false, relinked: false, claimed: true });
    } catch (err) {
      if (isUniqueViolation(err)) return again({ ok: false, reason: 'identity_mismatch' });
      throw err;
    }
  }

  const byEmail = await findUserByEmail(db, appId, email);
  if (byEmail) {
    if (byEmail.disabledAt) return { ok: false, reason: 'disabled' };
    const own = await identitiesOf(db, appId, byEmail.id);
    if (own.length === 0) {
      try {
        const [identity] = await db
          .insert(authIdentities)
          .values({ id: newIdentityId(), appId, userId: byEmail.id, provider, issuer, subject })
          .returning();
        return signInBound(db, appId, identity, input, { linked: true, relinked: false, claimed: false });
      } catch (err) {
        if (isUniqueViolation(err)) return again({ ok: false, reason: 'linked_elsewhere' });
        throw err;
      }
    }
    const [only] = own;
    if (opts.relinkByEmail && own.length === 1 && only.provider === provider && only.issuer !== issuer) {
      try {
        const [moved] = await db
          .update(authIdentities)
          .set({ issuer, subject })
          .where(
            and(
              eq(authIdentities.id, only.id),
              only.issuer === null ? isNull(authIdentities.issuer) : eq(authIdentities.issuer, only.issuer),
              eq(authIdentities.subject, only.subject)
            )
          )
          .returning();
        if (!moved) return again({ ok: false, reason: 'linked_elsewhere' });
        return signInBound(db, appId, moved, input, { linked: true, relinked: true, claimed: false });
      } catch (err) {
        if (isUniqueViolation(err)) return again({ ok: false, reason: 'linked_elsewhere' });
        throw err;
      }
    }
    return { ok: false, reason: 'linked_elsewhere' };
  }

  if ((await countUsers(db, appId)) >= opts.maxUsers) return { ok: false, reason: 'limit' };
  const now = new Date();
  try {
    const row = await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(authUsers)
        .values({ id: newUserId(), appId, email, role, provider, verifiedAt: now, lastLoginAt: now })
        .returning();
      await tx.insert(authIdentities).values({ id: newIdentityId(), appId, userId: user.id, provider, issuer, subject, lastLoginAt: now });
      return user;
    });
    return { ok: true, row, isNew: true, linked: false, relinked: false, claimed: false };
  } catch (err) {
    if (isUniqueViolation(err)) return again({ ok: false, reason: 'email_taken' });
    throw err;
  }
}
