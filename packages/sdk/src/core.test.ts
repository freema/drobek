import { describe, expect, it } from 'vitest';
import { DrobekError, createCore } from './core.js';

function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { f, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

describe('SDK core', () => {
  it('calls /__drobek/v1/<module><path>?query same-origin with X-Drobek-SDK: 1 and parses JSON', async () => {
    const { f, calls } = fakeFetch(() => json(200, { greeting: 'Hi' }));
    const core = createCore('hello', f);
    const out = await core.request<{ greeting: string }>('get', '', { query: { a: 1, b: undefined, c: 'x y' } });
    expect(out).toEqual({ greeting: 'Hi' });
    expect(calls[0].url).toBe('/__drobek/v1/hello?a=1&c=x+y');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.credentials).toBe('same-origin');
    expect((calls[0].init.headers as Record<string, string>)['X-Drobek-SDK']).toBe('1');
  });

  it('sends a JSON body with its content type', async () => {
    const { f, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const core = createCore('forms', f);
    expect(await core.request('POST', 'contact', { body: { a: 1 } })).toBeUndefined();
    expect(calls[0].url).toBe('/__drobek/v1/forms/contact');
    expect(calls[0].init.body).toBe('{"a":1}');
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('rejects with DrobekError carrying the uniform error shape', async () => {
    const { f } = fakeFetch(() =>
      json(429, { error: 'rate_limited', message: 'Slow down.', details: { retry_after: 3 }, hint: "skill_info('hello')" })
    );
    const err = await createCore('hello', f).request('GET').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DrobekError);
    expect(err).toMatchObject({ status: 429, code: 'rate_limited', message: 'Slow down.', details: { retry_after: 3 }, hint: "skill_info('hello')" });
  });

  it('a non-JSON failure still becomes a DrobekError', async () => {
    const { f } = fakeFetch(() => new Response('nope', { status: 502, statusText: 'Bad Gateway' }));
    await expect(createCore('x', f).request('GET')).rejects.toMatchObject({ status: 502, code: 'http_error' });
  });
});
