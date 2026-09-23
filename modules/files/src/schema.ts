/** The module's own table (created by ../migrations, journal `__drizzle_migrations_mod_files`). */
import { bigint, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const files = pgTable(
  'mod_files',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    /** The content address of the bytes on disk (shared by every row with the same content, any app). */
    sha256: text('sha256').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    /** The sniffed type (never the client's): one of FILE_TYPES. */
    type: text('type').notNull(),
    /** The client's file name, sanitized (download name only — never a path). */
    name: text('name').notNull().default(''),
    /** The signed-in end user who uploaded it, or null (an anonymous upload). */
    ownerId: text('owner_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('mod_files_app_created_idx').on(t.appId, t.createdAt.desc(), t.id.desc()), index('mod_files_sha256_idx').on(t.sha256)]
);

export type FileRow = typeof files.$inferSelect;
