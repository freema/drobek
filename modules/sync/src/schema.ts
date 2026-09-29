/** The module's own tables (created by ../migrations, journal `__drizzle_migrations_mod_sync`). */
import { index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const syncSources = pgTable(
  'mod_sync_sources',
  {
    appId: text('app_id').notNull(),
    source: text('source').notNull(),
    /** The source config the counters below belong to (a changed config starts over). */
    configHash: text('config_hash'),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastStatus: text('last_status').$type<'ok' | 'failed'>(),
    lastRecords: integer('last_records'),
    lastError: text('last_error'),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    /** Failed runs since the last success. */
    failures: integer('failures').notNull().default(0),
    /** Paused after SYNC_PAUSE_AFTER_FAILURES failed runs in a row (null: not paused so). */
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    /** The lease of a run in flight. */
    runningUntil: timestamp('running_until', { withTimezone: true }),
  },
  (t) => [primaryKey({ name: 'mod_sync_sources_pk', columns: [t.appId, t.source] })]
);

export type SyncSourceRow = typeof syncSources.$inferSelect;

export const syncRuns = pgTable(
  'mod_sync_runs',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    source: text('source').notNull(),
    trigger: text('trigger').$type<'schedule' | 'manual'>().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    durationMs: integer('duration_ms').notNull(),
    status: text('status').$type<'ok' | 'failed'>().notNull(),
    records: integer('records'),
    inserted: integer('inserted'),
    updated: integer('updated'),
    deleted: integer('deleted'),
    error: text('error'),
  },
  (t) => [
    index('mod_sync_runs_app_started_idx').on(t.appId, t.startedAt.desc(), t.id.desc()),
    index('mod_sync_runs_app_source_started_idx').on(t.appId, t.source, t.startedAt.desc()),
  ]
);

export type SyncRunRow = typeof syncRuns.$inferSelect;
