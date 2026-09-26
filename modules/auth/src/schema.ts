/** The module's own table (created by ../migrations, journal `__drizzle_migrations_mod_auth`). */
import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const authUsers = pgTable(
  'mod_auth_users',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    email: text('email').notNull(),
    role: text('role', { enum: ['user', 'admin'] }).notNull().default('user'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** The identity the account is linked to: `email` (none — the e-mail code) or an `auth.provider` id (0001, NSO-348). */
    provider: text('provider').notNull().default('email'),
    /** The IdP's stable id of the person (null exactly when `provider` is `email`). */
    subject: text('subject'),
  },
  (t) => [
    uniqueIndex('mod_auth_users_app_email_uq').on(t.appId, t.email),
    uniqueIndex('mod_auth_users_app_provider_subject_uq').on(t.appId, t.provider, t.subject).where(sql`"subject" IS NOT NULL`),
  ]
);

export type AuthUserRow = typeof authUsers.$inferSelect;
