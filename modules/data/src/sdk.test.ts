import { describe, expect, it } from 'vitest';
import { createCore } from '@drobek/sdk';
import data, { type ChangeEvent } from './sdk.js';

function sse(text: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
}

describe('drobek.data.subscribe', () => {
  it("opens the collection's event stream: ready / reset → onSync, change → onChange; unsubscribe aborts it", async () => {
    const urls: string[] = [];
    let signal: AbortSignal | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      signal = init?.signal ?? undefined;
      return sse(
        'retry: 2000\n\nid: 1-0\nevent: ready\ndata: {}\n\n' +
          'id: 2-0\nevent: change\ndata: {"op":"create","record":{"_id":"r1","title":"Milk"},"at":"t"}\n\n' +
          'id: 3-0\nevent: change\ndata: {"op":"delete","id":"r1","at":"t"}\n\nevent: reset\ndata: {}\n\n'
      );
    }) as typeof fetch;
    const api = data(createCore('data'), fetchImpl);
    const changes: ChangeEvent<{ title: string }>[] = [];
    let syncs = 0;
    const stop = api.subscribe<{ title: string }>('my list', { onChange: (e) => changes.push(e), onSync: () => (syncs += 1) });
    await until(() => changes.length === 2 && syncs === 2);
    stop();
    expect(urls[0]).toBe('/__drobek/v1/data/my%20list/events');
    expect(changes).toEqual([
      { op: 'create', record: { _id: 'r1', title: 'Milk' }, at: 't' },
      { op: 'delete', id: 'r1', at: 't' },
    ]);
    expect(signal?.aborted).toBe(true);
  });

  it('reports a refused subscription once through onError', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'unauthorized', message: 'Sign in first.' }), { status: 401, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const errors: string[] = [];
    data(createCore('data'), fetchImpl)
      .collection('todos')
      .subscribe({ onChange: () => undefined, onError: (e) => errors.push(e.code) });
    await until(() => errors.length === 1);
    expect(errors).toEqual(['unauthorized']);
  });
});
