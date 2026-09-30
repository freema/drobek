/**
 * The module's own table, created by ../migrations (journal
 * `__drizzle_migrations_mod_acmecrm`). Module tables are named
 * `mod_acmecrm_*` and reference apps(id) with ON DELETE CASCADE, so
 * deleting an app deletes its module data. One contact per app and address.
 */
import { bigserial, index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const contacts = pgTable(
  'mod_acmecrm_contacts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    appId: text('app_id').notNull(),
    email: text('email').notNull(),
    name: text('name'),
    /** `app` (POST /) or `sign-in` (the auth.signedIn observer). */
    source: text('source').notNull(),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    fields: jsonb('fields').$type<Record<string, string>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('mod_acmecrm_contacts_app_email_idx').on(t.appId, t.email), index('mod_acmecrm_contacts_app_idx').on(t.appId)]
);
