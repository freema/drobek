/**
 * The dashboard paths with their own body limit (the Data tab's collection
 * page, the CSV import) and the counted body read its route uses.
 */
import { describe, expect, it } from 'vitest';
import { IMPORT_REQUEST_MAX_BYTES, hasOwnBodyLimit, readBodyUpTo } from './body-limits.js';
import { IMPORT_MAX_BYTES } from './owner-view.js';

function streamed(chunks: Uint8Array[]): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Request('https://drobek.example/x', { method: 'POST', body, duplex: 'half' } as RequestInit);
}

describe('hasOwnBodyLimit', () => {
  it('the collection page (also as a React Router .data request) and nothing else', () => {
    for (const p of ['/workspaces/acme/apps/shop/data/todos', '/workspaces/acme/apps/shop/data/todos.data', '/workspaces/acme/apps/shop/data/todos/']) {
      expect(hasOwnBodyLimit(p), p).toBe(true);
    }
    for (const p of [
      '/workspaces/acme/apps/shop/data',
      '/workspaces/acme/apps/shop/data.data',
      '/workspaces/acme/apps/shop/data/todos/export.csv',
      '/workspaces/acme/apps/shop/settings',
      '/login',
      '/oauth/token',
      '/x/workspaces/acme/apps/shop/data/todos',
    ]) {
      expect(hasOwnBodyLimit(p), p).toBe(false);
    }
  });

  it('allows the import file plus 64 KiB of form fields and framing', () => {
    expect(IMPORT_REQUEST_MAX_BYTES).toBe(IMPORT_MAX_BYTES + 64 * 1024);
  });
});

describe('readBodyUpTo', () => {
  it('returns the body when it fits — however it is chunked', async () => {
    const body = await readBodyUpTo(streamed([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])]), 5);
    expect([...(body ?? [])]).toEqual([1, 2, 3, 4, 5]);
    expect((await readBodyUpTo(new Request('https://drobek.example/x', { method: 'POST' }), 5))?.byteLength).toBe(0);
  });

  it('null past the limit, after reading the rest to the end', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 10) controller.close();
        else controller.enqueue(new Uint8Array(100));
      },
    });
    expect(await readBodyUpTo(new Request('https://drobek.example/x', { method: 'POST', body, duplex: 'half' } as RequestInit), 250)).toBeNull();
    expect(pulled).toBe(11);
  });
});
