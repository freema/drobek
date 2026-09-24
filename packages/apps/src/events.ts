/**
 * "An app changed" notifications (M0-05/M0-06): every new version, restore and
 * publish announces itself so the app hosts' serve cache drops what it knows
 * about that app. Two paths, both best effort:
 *   - the Redis pub/sub channel `drobek:app-changed` (every drobek process,
 *     incl. a future second replica, subscribes);
 *   - an in-process emitter, so THIS process busts synchronously — the next
 *     request after a write/publish never races the pub/sub round trip.
 * The cache also has a short TTL backstop, so a lost message only delays.
 */
import { EventEmitter } from 'node:events';
import { getRedis, type Logger } from '@drobek/core';
import { dbErrorForLog } from '@drobek/db';

/** Redis pub/sub channel the app hosts' serve cache listens on. */
export const APP_CHANGED_CHANNEL = 'drobek:app-changed';

export interface AppChangedEvent {
  app_id: string;
  slug: string;
  /** The version that was written / restored / published, when there is one. */
  version?: number;
  /**
   * `domain` (M3-01): a custom domain of the app was added, verified, unverified, removed or made primary.
   * `create` (NSO-315): the app row was just created — the app hosts forget a
   * cached "no such slug", so the new app is reachable at once.
   */
  kind?: 'version' | 'publish' | 'unpublish' | 'settings' | 'delete' | 'domain' | 'create';
}

const local = new EventEmitter();
local.setMaxListeners(0);

/** Listen to this process's own app-changed events (the serve cache does). */
export function onLocalAppChanged(listener: (event: AppChangedEvent) => void): () => void {
  local.on('changed', listener);
  return () => local.off('changed', listener);
}

/** Emit locally only (tests, and the Redis subscriber relays remote events here). */
export function emitLocalAppChanged(event: AppChangedEvent): void {
  local.emit('changed', event);
}

/** Parse a pub/sub payload; null for anything that is not a well-formed event. */
export function parseAppChangedEvent(raw: string): AppChangedEvent | null {
  try {
    const e = JSON.parse(raw) as Partial<AppChangedEvent>;
    if (!e || typeof e.app_id !== 'string' || typeof e.slug !== 'string') return null;
    return e as AppChangedEvent;
  } catch {
    return null;
  }
}

/**
 * Announce a change: bust this process's cache now, then tell every other
 * process through Redis. Never throws — a failed publish is logged and the
 * cache TTL backstop covers it.
 */
export async function notifyAppChanged(event: AppChangedEvent, log?: Logger): Promise<void> {
  emitLocalAppChanged(event);
  try {
    await getRedis().publish(APP_CHANGED_CHANNEL, JSON.stringify(event));
  } catch (err) {
    log?.warn('app-changed publish failed', { app_id: event.app_id, error: dbErrorForLog(err) });
  }
}
