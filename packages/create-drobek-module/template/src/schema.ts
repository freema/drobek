/**
 * The module's own table, created by ../migrations (journal
 * `__drizzle_migrations_mod_{{module}}`). Module tables are named
 * `mod_{{module}}_*` and reference apps(id) with ON DELETE CASCADE, so
 * deleting an app deletes its module data.
 */
import { bigserial, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const items = pgTable(
  'mod_{{module}}_items',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    appId: text('app_id').notNull(),
    title: text('title').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('mod_{{module}}_items_app_idx').on(t.appId)]
);
