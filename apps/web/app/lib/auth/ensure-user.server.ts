import { eq } from 'drizzle-orm';
import { getDb, users } from '@drobek/db';
import { normalizeAuthEmail } from './email-code.server';

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
