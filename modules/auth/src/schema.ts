/** The module's own tables (created by ../migrations, journal `__drizzle_migrations_mod_auth`). */
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
    /** The sign-in provider the account is linked to (its row in `mod_auth_identities`), or `email` (none). */
    provider: text('provider').notNull().default('email'),
  },
  (t) => [uniqueIndex('mod_auth_users_app_email_uq').on(t.appId, t.email)]
);

export type AuthUserRow = typeof authUsers.$inferSelect;

/**
 * External identities (0002, NSO-360): who a provider proved, bound to one
 * local user. The key is (app, provider, issuer, subject) — the same subject
 * from another issuer is another person. `issuer` null = an identity linked
 * before issuers were recorded (0001): claimed once by the same subject with
 * the user's own verified address.
 */
export const authIdentities = pgTable(
  'mod_auth_identities',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    userId: text('user_id').notNull(),
    provider: text('provider').notNull(),
    issuer: text('issuer'),
    subject: text('subject').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('mod_auth_identities_key_uq').on(t.appId, t.provider, t.issuer, t.subject).where(sql`"issuer" IS NOT NULL`),
    uniqueIndex('mod_auth_identities_legacy_uq').on(t.appId, t.provider, t.subject).where(sql`"issuer" IS NULL`),
    uniqueIndex('mod_auth_identities_user_provider_uq').on(t.userId, t.provider),
  ]
);

export type AuthIdentityRow = typeof authIdentities.$inferSelect;
