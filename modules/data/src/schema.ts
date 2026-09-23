/** The module's own table (created by ../migrations, journal `__drizzle_migrations_mod_data`). */
import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const dataRecords = pgTable(
  'mod_data_documents',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    collection: text('collection').notNull(),
    /** The signed-in end user who created the record (server-set), or null (an anonymous create). */
    ownerId: text('owner_id'),
    /** The record's own fields (never the server's `_…` fields). */
    doc: jsonb('doc').$type<Record<string, unknown>>().notNull(),
    /** UTF-8 bytes of the record's JSON (the quota sums it). */
    bytes: integer('bytes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('mod_data_documents_app_collection_created_idx').on(t.appId, t.collection, t.createdAt.desc(), t.id.desc()),
    index('mod_data_documents_app_collection_owner_idx').on(t.appId, t.collection, t.ownerId),
  ]
);

export type DataRecordRow = typeof dataRecords.$inferSelect;
