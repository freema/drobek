import { eq } from 'drizzle-orm';
import { getDb, users } from '@drobek/db';
import { normalizeAuthEmail } from './email-code.server.js';
import type { GoogleIdentity } from './google-oauth.server.js';

/**
 * Ensure a `users` row exists for this e-mail (normalized trim+lowercase);
 * returns the user id. Race-safe: a lost concurrent-insert race falls back
 * to re-reading the winner's row. NO schema changes — the users table from
 * packages/db is used as-is.
 */
export async function ensureUserByEmail(emailRaw: string): Promise<string> {
  const db = getDb();
  const email = normalizeAuthEmail(emailRaw);

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing[0]?.id) return existing[0].id;

  const [created] = await db
    .insert(users)
    .values({ email })
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id });
  if (created?.id) return created.id;

  // Concurrent insert won — read the winner.
  const again = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (again[0]?.id) return again[0].id;

  throw new Error('failed to ensure user');
}

// ── U3: Google OIDC account resolution ("account-link by email") ─────────────

/**
 * Minimal persistence seam so the resolution ORDER is unit-testable against a
 * fake store (google-oauth resolution is pure decision logic; the drizzle
 * implementation below is a thin adapter).
 */
export interface GoogleUserStore {
  findUserBySub(sub: string): Promise<{ id: string; email: string } | null>;
  findUserIdByEmail(email: string): Promise<string | null>;
  setGoogleSub(userId: string, sub: string): Promise<void>;
  /** Returns null when the email-unique insert lost a concurrent race. */
  createUser(email: string, sub: string): Promise<string | null>;
}

/**
 * Resolution order (U3 acceptance — same user on email match, no dup rows):
 *  (a) `google_sub` match wins → log in that user;
 *  (b) else normalized-email match (magic-code signup) → LINK: set google_sub
 *      on the SAME users row;
 *  (c) else create a new user with email + google_sub.
 * An unverified Google email is rejected outright — it must never create a
 * session or link an account.
 */
export async function resolveGoogleUser(
  store: GoogleUserStore,
  identity: GoogleIdentity
): Promise<{ userId: string; email: string }> {
  if (!identity.emailVerified) {
    throw new Error('google identity email is not verified');
  }
  if (!identity.sub || !identity.email) {
    throw new Error('google identity missing sub/email');
  }
  const email = normalizeAuthEmail(identity.email);

  // (a) sub match wins over everything. The session gets the users-row email
  // (the canonical drobek identity), NOT the incoming Google email — the two
  // can drift when a Google account changes its address.
  const bySub = await store.findUserBySub(identity.sub);
  if (bySub) return { userId: bySub.id, email: bySub.email };

  // (b) existing email (e.g. magic-code signup) → link, same user id.
  const byEmail = await store.findUserIdByEmail(email);
  if (byEmail) {
    await store.setGoogleSub(byEmail, identity.sub);
    return { userId: byEmail, email };
  }

  // (c) brand-new user.
  const created = await store.createUser(email, identity.sub);
  if (created) return { userId: created, email };

  // Lost a concurrent email-insert race — the winner exists now; link it.
  const again = await store.findUserIdByEmail(email);
  if (again) {
    await store.setGoogleSub(again, identity.sub);
    return { userId: again, email };
  }

  throw new Error('failed to resolve google user');
}

function drizzleGoogleUserStore(): GoogleUserStore {
  const db = getDb();
  return {
    async findUserBySub(sub) {
      const rows = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.googleSub, sub))
        .limit(1);
      return rows[0] ?? null;
    },
    async findUserIdByEmail(email) {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      return rows[0]?.id ?? null;
    },
    async setGoogleSub(userId, sub) {
      await db.update(users).set({ googleSub: sub }).where(eq(users.id, userId));
    },
    async createUser(email, sub) {
      const [created] = await db
        .insert(users)
        .values({ email, googleSub: sub })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id });
      return created?.id ?? null;
    },
  };
}

/** Route-facing entry — resolution against the real users table. */
export async function ensureUserFromGoogle(
  identity: GoogleIdentity
): Promise<{ userId: string; email: string }> {
  return resolveGoogleUser(drizzleGoogleUserStore(), identity);
}
