/** The module's own table (created by ../migrations, journal `__drizzle_migrations_mod_forms`). */
import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const formSubmissions = pgTable(
  'mod_forms_submissions',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    form: text('form').notNull(),
    data: jsonb('data').$type<Record<string, FieldValue>>().notNull(),
    ipHash: text('ip_hash'),
    userId: text('user_id'),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('mod_forms_submissions_app_form_created_idx').on(t.appId, t.form, t.createdAt.desc(), t.id.desc())]
);

/** A stored field value (see fields.ts). */
export type FieldValue = string | number | boolean | null | string[];

export type FormSubmissionRow = typeof formSubmissions.$inferSelect;
