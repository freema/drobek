/**
 * Keeps the app hosts' cache honest (M0-06): every `drobek:app-changed` event —
 * a new version (write_files, create_app, restore_version) or a publish (MCP or
 * dashboard) — busts what the serve cache knows about that app's hosts.
 *
 * Two feeds: the in-process emitter (this process's own changes, synchronous —
 * the first request after a publish already sees the new version) and a
 * dedicated Redis subscriber connection (changes made by any other process).
 * Busting twice is harmless. A `domain` event (M3-01) also drops every cached
 * custom-host resolution.
 */
import type { Redis } from 'ioredis';
import {
  APP_CHANGED_CHANNEL,
  emitLocalAppChanged,
  onLocalAppChanged,
  parseAppChangedEvent,
} from '@drobek/apps';
import { getRedis, type Logger } from '@drobek/core';
import type { ServeStore } from './store.server.js';

export interface ServeCacheSubscription {
  stop(): Promise<void>;
}

/**
 * Wire `store` to the app-changed feeds. `redis` = the connection to
 * `duplicate()` for SUBSCRIBE (a subscribed ioredis connection can do nothing
 * else); pass `null` to listen in-process only (tests).
 */
export function subscribeServeCache(
  store: ServeStore,
  opts: { redis?: Redis | null; log?: Logger } = {}
): ServeCacheSubscription {
  const offLocal = onLocalAppChanged((e) => {
    store.bust(e.slug);
    // M3-01: a domain change can move ANY custom hostname (added / verified / removed).
    if (e.kind === 'domain') store.bustCustomHosts();
  });

  const base = opts.redis === undefined ? getRedis() : opts.redis;
  let sub: Redis | null = null;
  if (base) {
    sub = base.duplicate();
    sub.on('message', (channel: string, raw: string) => {
      if (channel !== APP_CHANGED_CHANNEL) return;
      const event = parseAppChangedEvent(raw);
      // Relay into the local emitter: this store and any other local listener bust.
      if (event) emitLocalAppChanged(event);
    });
    // After a reconnect the subscription is restored by ioredis, but events may
    // have been missed meanwhile — drop every host resolution to be safe.
    sub.on('ready', () => store.bustAll());
    sub.on('error', (err: Error) => opts.log?.warn('app-changed subscriber error', { error: String(err) }));
    sub.subscribe(APP_CHANGED_CHANNEL).catch((err: unknown) => {
      opts.log?.warn('app-changed subscribe failed', { error: String(err) });
    });
  }

  return {
    async stop() {
      offLocal();
      if (sub) await sub.quit().catch(() => sub?.disconnect());
    },
  };
}
