/** The module's own table (created by ../migrations, journal `__drizzle_migrations_mod_hello`). */
import { bigserial, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const helloWaves = pgTable(
  'mod_hello_waves',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    appId: text('app_id').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('mod_hello_waves_app_idx').on(t.appId)]
);
