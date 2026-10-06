import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrobekError } from './core.js';
import { openEventStream, sseParser, type StreamEvent } from './events.js';

/** A Response whose body streams `chunks`, then ends (or stays open with `hold`). */
function sse(chunks: string[], opts: { hold?: boolean } = {}): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      if (!opts.hold) c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
}

afterEach(() => vi.useRealTimers());

describe('sseParser', () => {
  it('parses events split across chunks, multi-line data, comments, CRLF and a persistent id', () => {
    const p = sseParser();
    expect(p.push(': ping\n\nid: 1-0\nevent: change\nda')).toEqual([]);
    expect(p.push('ta: {"a":\r\ndata: 1}\r\n\r\ndata: x\n\n')).toEqual([
      { type: 'change', data: '{"a":\n1}', id: '1-0' },
      { type: 'message', data: 'x', id: '1-0' },
    ]);
    p.push('retry: 2500\n\n');
    expect(p.retry()).toBe(2500);
  });
});

describe('openEventStream', () => {
  it('sends X-Drobek-SDK, delivers events and resumes with Last-Event-ID after the server ends the stream', async () => {
    const calls: RequestInit[] = [];
    const responses = [sse(['retry: 1\n\n', 'id: 5-0\nevent: change\ndata: {"n":1}\n\n']), sse(['id: 6-0\nevent: change\ndata: {"n":2}\n\n'], { hold: true })];
    const events: StreamEvent[] = [];
    const close = openEventStream('/__drobek/v1/data/x/events', {
      onEvent: (e) => events.push(e),
      fetchImpl: async (_url, init) => {
        calls.push(init!);
        return responses.shift() ?? sse([], { hold: true });
      },
    });
    await until(() => events.length === 2);
    close();
    expect(events.map((e) => e.data)).toEqual(['{"n":1}', '{"n":2}']);
    const h0 = calls[0].headers as Record<string, string>;
    expect(h0['X-Drobek-SDK']).toBe('1');
    expect(h0['Last-Event-ID']).toBeUndefined();
    expect(calls[0].credentials).toBe('same-origin');
    expect((calls[1].headers as Record<string, string>)['Last-Event-ID']).toBe('5-0');
  });

  it('stops for good on a 4xx answer and reports the drobek error', async () => {
    let n = 0;
    const errors: DrobekError[] = [];
    openEventStream('/x', {
      onEvent: () => undefined,
      onError: (e) => errors.push(e),
      retryMs: 1,
      fetchImpl: async () => {
        n += 1;
        return json(401, { error: 'unauthorized', message: 'Sign in first.' });
      },
    });
    await until(() => errors.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(n).toBe(1);
    expect(errors[0]).toMatchObject({ status: 401, code: 'unauthorized', message: 'Sign in first.' });
  });

  it('retries a 429 / 503 and a dropped connection', async () => {
    const answers: (() => Response | Promise<Response>)[] = [
      () => json(429, { error: 'limit_exceeded', message: 'busy' }),
      () => Promise.reject(new TypeError('network')),
      () => json(503, { error: 'unavailable', message: 'stopping' }),
      () => sse(['event: change\ndata: ok\n\n'], { hold: true }),
    ];
    const events: StreamEvent[] = [];
    const close = openEventStream('/x', { onEvent: (e) => events.push(e), retryMs: 1, fetchImpl: async () => answers.shift()!() });
    await until(() => events.length === 1);
    close();
    expect(events[0]).toMatchObject({ type: 'change', data: 'ok' });
  });

  it('an error event with a final code stops; another code keeps the stream', async () => {
    const errors: DrobekError[] = [];
    const events: StreamEvent[] = [];
    openEventStream('/x', {
      onEvent: (e) => events.push(e),
      onError: (e) => errors.push(e),
      fetchImpl: async () =>
        sse(['event: error\ndata: {"error":"slow_client"}\n\n', 'event: change\ndata: 1\n\n', 'event: error\ndata: {"error":"forbidden","message":"no"}\n\n'], {
          hold: true,
        }),
    });
    await until(() => errors.length === 1);
    expect(events).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'forbidden', message: 'no' });
  });

  it('close() aborts the request and no callback runs after it', async () => {
    let signal: AbortSignal | undefined;
    const events: StreamEvent[] = [];
    const close = openEventStream('/x', {
      onEvent: (e) => events.push(e),
      fetchImpl: async (_u, init) => {
        signal = init?.signal ?? undefined;
        return sse([], { hold: true });
      },
    });
    await until(() => signal !== undefined);
    close();
    expect(signal!.aborted).toBe(true);
    expect(events).toEqual([]);
  });
});
