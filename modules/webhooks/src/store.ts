/**
 * The module's rows: the delivery log (never a body, header or secret) and
 * the sender event ids already stored (a retried delivery is stored once).
 * Both cascade with the app; `pruneDeliveries` (the daily server job) keeps
 * DELIVERIES_KEPT_DAYS of the log, at most DELIVERIES_KEPT_PER_APP rows per
 * app, and drops expired event ids.
 */
import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { DB } from '@drobek/db';
import type { WebhookDelivery, WebhookDeliveryStatus } from '@drobek/modules';
import { webhookDeliveries, webhookEvents, type WebhookDeliveryRow } from './schema.js';

/** How long an event id is remembered (senders retry for up to three days). */
export const EVENT_ID_TTL_MS = 7 * 24 * 60 * 60_000;
export const DELIVERIES_KEPT_DAYS = 30;
export const DELIVERIES_KEPT_PER_APP = 1000;
const DELIVERIES_MAX_PAGE = 100;

export interface DeliveryInput {
  appId: string;
  endpoint: string;
  status: WebhookDeliveryStatus;
  httpStatus: number;
  bytes: number;
  reason?: string | null;
  recordId?: string | null;
}

export async function logDelivery(db: DB, input: DeliveryInput): Promise<void> {
  await db.insert(webhookDeliveries).values({
    id: createId(),
    appId: input.appId,
    endpoint: input.endpoint,
    status: input.status,
    httpStatus: input.httpStatus,
    bytes: input.bytes,
    reason: input.reason ?? null,
    recordId: input.recordId ?? null,
  });
}

/**
 * Claim a sender event id for this app + endpoint: true when it is new (or
 * its earlier claim expired), false when a delivery with it was stored
 * already — one statement, so two concurrent retries cannot both win.
 */
export async function claimEvent(db: DB, input: { appId: string; endpoint: string; eventId: string; now?: Date }): Promise<boolean> {
  const now = input.now ?? new Date();
  const rows = await db
    .insert(webhookEvents)
    .values({ appId: input.appId, endpoint: input.endpoint, eventId: input.eventId, expiresAt: new Date(now.getTime() + EVENT_ID_TTL_MS) })
    .onConflictDoUpdate({
      target: [webhookEvents.appId, webhookEvents.endpoint, webhookEvents.eventId],
      set: { expiresAt: new Date(now.getTime() + EVENT_ID_TTL_MS) },
      setWhere: lt(webhookEvents.expiresAt, now),
    })
    .returning({ eventId: webhookEvents.eventId });
  return rows.length > 0;
}

/** Give a claim back (the delivery was not stored: the sender's retry must be stored). */
export async function releaseEvent(db: DB, input: { appId: string; endpoint: string; eventId: string }): Promise<void> {
  await db
    .delete(webhookEvents)
    .where(and(eq(webhookEvents.appId, input.appId), eq(webhookEvents.endpoint, input.endpoint), eq(webhookEvents.eventId, input.eventId)));
}

function deliveryView(row: WebhookDeliveryRow): WebhookDelivery {
  return {
    endpoint: row.endpoint,
    status: row.status,
    http_status: row.httpStatus,
    bytes: row.bytes,
    reason: row.reason,
    record_id: row.recordId,
    received_at: row.receivedAt.toISOString(),
  };
}

/** The latest deliveries of an app, newest first (`endpoint` narrows, `since` bounds, ≤ 100). */
export async function recentDeliveries(db: DB, appId: string, q: { endpoint?: string; since?: Date; limit?: number } = {}): Promise<WebhookDelivery[]> {
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? 50), 1), DELIVERIES_MAX_PAGE);
  const rows = await db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.appId, appId),
        q.endpoint ? eq(webhookDeliveries.endpoint, q.endpoint) : undefined,
        q.since ? gte(webhookDeliveries.receivedAt, q.since) : undefined
      )
    )
    .orderBy(desc(webhookDeliveries.receivedAt), desc(webhookDeliveries.id))
    .limit(limit);
  return rows.map(deliveryView);
}

/** The newest delivery of each endpoint of an app. */
export async function lastDeliveries(db: DB, appId: string): Promise<Map<string, WebhookDelivery>> {
  const rows = await db
    .selectDistinctOn([webhookDeliveries.endpoint])
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.appId, appId))
    .orderBy(webhookDeliveries.endpoint, desc(webhookDeliveries.receivedAt), desc(webhookDeliveries.id));
  return new Map(rows.map((r) => [r.endpoint, deliveryView(r)]));
}

/** The daily clean-up: old and surplus deliveries, expired event ids. */
export async function pruneDeliveries(db: DB, now: Date = new Date()): Promise<{ deliveries: number; events: number }> {
  const cutoff = new Date(now.getTime() - DELIVERIES_KEPT_DAYS * 24 * 60 * 60_000);
  const old = await db.delete(webhookDeliveries).where(lt(webhookDeliveries.receivedAt, cutoff)).returning({ id: webhookDeliveries.id });
  const surplus = await db.execute(sql`
    DELETE FROM ${webhookDeliveries} WHERE ${webhookDeliveries.id} IN (
      SELECT id FROM (
        SELECT id, row_number() OVER (PARTITION BY app_id ORDER BY received_at DESC, id DESC) AS n FROM ${webhookDeliveries}
      ) ranked WHERE ranked.n > ${DELIVERIES_KEPT_PER_APP}
    ) RETURNING ${webhookDeliveries.id}`);
  const events = await db.delete(webhookEvents).where(lt(webhookEvents.expiresAt, now)).returning({ id: webhookEvents.eventId });
  return { deliveries: old.length + rowCount(surplus), events: events.length };
}

function rowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  const r = result as { rows?: unknown[]; rowCount?: number | null; affectedRows?: number };
  return r.rows?.length ?? r.rowCount ?? r.affectedRows ?? 0;
}
