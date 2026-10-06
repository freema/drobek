/** The module's own tables (created by ../migrations, journal `__drizzle_migrations_mod_webhooks`). */
import type { WebhookDeliveryStatus } from '@drobek/modules';
import { index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const webhookDeliveries = pgTable(
  'mod_webhooks_deliveries',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    endpoint: text('endpoint').notNull(),
    status: text('status').$type<WebhookDeliveryStatus>().notNull(),
    httpStatus: integer('http_status').notNull(),
    bytes: integer('bytes').notNull(),
    reason: text('reason'),
    recordId: text('record_id'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('mod_webhooks_deliveries_app_received_idx').on(t.appId, t.receivedAt.desc(), t.id.desc()),
    index('mod_webhooks_deliveries_received_idx').on(t.receivedAt),
  ]
);

export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;

export const webhookEvents = pgTable(
  'mod_webhooks_events',
  {
    appId: text('app_id').notNull(),
    endpoint: text('endpoint').notNull(),
    eventId: text('event_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ name: 'mod_webhooks_events_pk', columns: [t.appId, t.endpoint, t.eventId] }), index('mod_webhooks_events_expires_idx').on(t.expiresAt)]
);
