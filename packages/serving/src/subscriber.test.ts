import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { APP_CHANGED_CHANNEL } from '@drobek/apps';
import { ServeStore } from './store.server.js';
import { subscribeServeCache } from './subscriber.server.js';

/** A stand-in for the duplicated ioredis subscriber connection. */
class FakeSub extends EventEmitter {
  subscribed: string[] = [];
  quit = vi.fn(async () => 'OK');
  subscribe = vi.fn(async (channel: string) => {
    this.subscribed.push(channel);
    return 1;
  });
  disconnect = vi.fn();
}

describe('subscribeServeCache over Redis pub/sub', () => {
  it('subscribes to drobek:app-changed and busts the slug of every well-formed event', async () => {
    const sub = new FakeSub();
    const base = { duplicate: () => sub } as unknown as Redis;
    const store = new ServeStore();
    const bust = vi.spyOn(store, 'bust');
    const s = subscribeServeCache(store, { redis: base });

    expect(sub.subscribed).toEqual([APP_CHANGED_CHANNEL]);
    sub.emit('message', APP_CHANGED_CHANNEL, JSON.stringify({ app_id: 'a1', slug: 'shop', version: 3 }));
    expect(bust).toHaveBeenCalledWith('shop');

    // Other channels and junk payloads are ignored.
    bust.mockClear();
    sub.emit('message', 'other', JSON.stringify({ app_id: 'a1', slug: 'x' }));
    sub.emit('message', APP_CHANGED_CHANNEL, 'not json');
    sub.emit('message', APP_CHANGED_CHANNEL, JSON.stringify({ slug: 1 }));
    expect(bust).not.toHaveBeenCalled();

    await s.stop();
    expect(sub.quit).toHaveBeenCalled();
    // After stop the local feed no longer reaches this store.
    sub.emit('message', APP_CHANGED_CHANNEL, JSON.stringify({ app_id: 'a1', slug: 'shop' }));
    expect(bust).not.toHaveBeenCalled();
  });

  it('a (re)connect drops every host resolution (events may have been missed)', async () => {
    const sub = new FakeSub();
    const store = new ServeStore();
    const all = vi.spyOn(store, 'bustAll');
    const s = subscribeServeCache(store, { redis: { duplicate: () => sub } as unknown as Redis });
    sub.emit('ready');
    expect(all).toHaveBeenCalledTimes(1);
    await s.stop();
  });
});
