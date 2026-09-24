/**
 * The ModuleRouter pipeline through createModuleTestContext (the same
 * runRoute production uses): CSRF, rules, rate limit, validation, errors.
 */
import { describe, expect, it } from 'vitest';
import { collectRoutes, matchRoute, normalizePattern, runRoute } from './router.js';
import { createModuleTestContext } from './testing.js';
import { echo } from './test/fixtures.js';

const user = { kind: 'user', id: 'u1', email: 'u@example.com', role: 'user' } as const;

describe('route table', () => {
  it('matches params, 405 with Allow, 404', () => {
    const routes = collectRoutes(echo.routes!.bind(echo) as never);
    const hit = matchRoute(routes, 'GET', '/items/a%20b');
    expect(hit).toMatchObject({ kind: 'route', params: { id: 'a b' } });
    expect(matchRoute(routes, 'HEAD', '/')).toMatchObject({ kind: 'route' });
    expect(matchRoute(routes, 'PUT', '/items/1')).toEqual({ kind: 'method_not_allowed', allow: ['GET', 'DELETE'] });
    expect(matchRoute(routes, 'GET', '/nope')).toEqual({ kind: 'not_found' });
  });

  it('rejects bad patterns and duplicates', () => {
    expect(() => normalizePattern('/a b')).toThrow();
    expect(normalizePattern('a//b/')).toBe('/a/b');
    expect(() =>
      collectRoutes((r) => {
        r.get('/x', () => 1);
        r.get('/x/', () => 2);
      })
    ).toThrow(/twice/);
  });
});

describe('pipeline', () => {
  it('config-derived rule: anon → 401, user → 200', async () => {
    const t = createModuleTestContext(echo, { secrets: { ECHO_TOKEN: 's3cr3t-value' } });
    const anon = await t.request('GET', '/');
    expect(anon.status).toBe(401);
    expect(anon.body).toEqual({ error: 'unauthorized', message: 'Sign in to this app first.', hint: "skill_info('echo')" });
    t.setPrincipal(user);
    const ok = await t.request('GET', '/');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ greeting: 'hi', principal: 'user:user', hasToken: true });
    expect(ok.headers['Cache-Control']).toBe('no-store');
    const open = createModuleTestContext(echo, { config: { access: 'public' } });
    expect((await open.request('GET', '/')).status).toBe(200);
  });

  it('CSRF: foreign Origin, null Origin, cross-site fetch, missing SDK header → 403', async () => {
    const t = createModuleTestContext(echo);
    const body = { text: 'x' };
    for (const headers of <Record<string, string>[]>[
      { origin: 'https://evil.example' },
      { origin: 'null' },
      { origin: '', 'sec-fetch-site': 'cross-site' },
      { 'x-drobek-sdk': '0' },
    ]) {
      const res = await t.request('POST', '/say', { body, headers });
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(res.body).toMatchObject({ error: 'csrf_rejected' });
    }
    expect((await t.request('POST', '/say', { body })).status).toBe(200);
    // same-origin mode does not need the SDK header
    expect((await t.request('DELETE', '/items/1', { headers: { 'x-drobek-sdk': '' } })).status).toBe(204);
    expect((await t.request('DELETE', '/items/1', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
  });

  it('validates the body with field paths; wrong content type; bad JSON; too large', async () => {
    const t = createModuleTestContext(echo);
    const res = await t.request('POST', '/say', { body: { text: '', n: 1.5 } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: 'invalid_request',
      details: [{ path: 'text' }, { path: 'n' }],
      hint: "skill_info('echo')",
    });
    expect((await t.request('POST', '/say', { body: { text: 'x' }, headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    expect((await t.request('POST', '/say', { body: { text: 'x'.repeat(40_000) } })).status).toBe(413);
  });

  it('rate limit from a named limit: 429 + Retry-After', async () => {
    const t = createModuleTestContext(echo, { limits: { ECHO_PER_MINUTE: 2 } });
    expect((await t.request('POST', '/say', { body: { text: 'a' } })).status).toBe(200);
    expect((await t.request('POST', '/say', { body: { text: 'b' } })).status).toBe(200);
    const res = await t.request('POST', '/say', { body: { text: 'c' } });
    expect(res.status).toBe(429);
    expect(res.headers['Retry-After']).toBe('60');
    expect(res.body).toMatchObject({ error: 'rate_limited', details: { limit: 2, window_seconds: 60 } });
    // another IP has its own window
    expect((await t.request('POST', '/say', { body: { text: 'd' }, clientIp: '10.0.0.9' })).status).toBe(200);
  });

  it("per: 'ip' without a resolved client IP (NSO-328): the bucket is skipped, never shared; known IPs stay limited", async () => {
    const t = createModuleTestContext(echo, { limits: { ECHO_PER_MINUTE: 2 } });
    for (let i = 0; i < 6; i += 1) {
      expect((await t.request('POST', '/say', { body: { text: `n${i}` }, clientIp: null })).status).toBe(200);
    }
    // IP-less traffic spent no known client's budget, and known IPs are still limited.
    expect((await t.request('POST', '/say', { body: { text: 'a' } })).status).toBe(200);
    expect((await t.request('POST', '/say', { body: { text: 'b' } })).status).toBe(200);
    expect((await t.request('POST', '/say', { body: { text: 'c' } })).status).toBe(429);
  });

  it("per: 'principal' without a client IP: anonymous callers skip the bucket, signed-in users keep theirs; per: 'app' always applies", async () => {
    const { defineModule, z } = await import('./index.js');
    const m = defineModule({
      name: 'lim',
      version: '1.0.0',
      skill: { useWhen: 'x', markdown: '# x' },
      configSchema: z.object({}),
      configDefaults: {},
      routes(r) {
        r.post('/p', { rule: 'public', rateLimit: { bucket: 'p', max: 2, windowMs: 60_000, per: 'principal' } }, () => ({ ok: true }));
        r.post('/a', { rule: 'public', rateLimit: { bucket: 'a', max: 2, windowMs: 60_000, per: 'app' } }, () => ({ ok: true }));
      },
    });
    const t = createModuleTestContext(m);
    for (let i = 0; i < 5; i += 1) expect((await t.request('POST', '/p', { clientIp: null })).status).toBe(200);
    t.setPrincipal(user);
    expect((await t.request('POST', '/p', { clientIp: null })).status).toBe(200);
    expect((await t.request('POST', '/p', { clientIp: null })).status).toBe(200);
    expect((await t.request('POST', '/p', { clientIp: null })).status).toBe(429);
    expect((await t.request('POST', '/a', { clientIp: null })).status).toBe(200);
    expect((await t.request('POST', '/a', { clientIp: null })).status).toBe(200);
    expect((await t.request('POST', '/a', { clientIp: null })).status).toBe(429);
  });

  it('a handler ModuleError keeps its own hint; audit is namespaced', async () => {
    const t = createModuleTestContext(echo);
    expect((await t.request('GET', '/teapot')).body).toEqual({ error: 'forbidden', message: 'no tea', hint: "skill_info('tea')" });
    await t.request('POST', '/say', { body: { text: 'abc' } });
    expect(t.audits).toEqual([{ action: 'echo.said', meta: { length: 3 } }]);
  });

  it('an unexpected throw is not swallowed by the pipeline (the runtime maps it to 500)', async () => {
    const t = createModuleTestContext(echo);
    await expect(t.request('GET', '/boom')).rejects.toThrow('kaboom');
  });
});

describe('body types', () => {
  const B = 'xYzBoundary';
  const multipart = (fields: [string, string][], extra = '') =>
    fields.map(([k, v]) => `--${B}\r\nContent-Disposition: form-data; name="${k}"${extra}\r\n\r\n${v}\r\n`).join('') + `--${B}--\r\n`;

  it('JSON by default: multipart → 415', async () => {
    const t = createModuleTestContext(echo);
    const res = await t.request('POST', '/say', { rawBody: multipart([['text', 'x']]), headers: { 'content-type': `multipart/form-data; boundary=${B}` } });
    expect(res.status).toBe(415);
    expect(res.body).toMatchObject({ error: 'unsupported_media_type', message: expect.stringContaining('JSON') });
  });

  it("bodyTypes ['json','multipart']: text fields parse; files → 415; other types → 415; JSON still works", async () => {
    const { defineModule, z } = await import('./index.js');
    const form = defineModule({
      name: 'form',
      version: '1.0.0',
      skill: { useWhen: 'x', markdown: '# x' },
      configSchema: z.object({}),
      configDefaults: {},
      routes(r) {
        r.post('/in', { rule: 'public', bodyTypes: ['json', 'multipart'] }, (q) => ({ got: q.body }));
      },
    });
    const t = createModuleTestContext(form);
    const ct = { 'content-type': `multipart/form-data; boundary=${B}` };
    const ok = await t.request('POST', '/in', { rawBody: multipart([['a', '1'], ['b', 'x'], ['b', 'y']]), headers: ct });
    expect(ok).toMatchObject({ status: 200, body: { got: { a: '1', b: ['x', 'y'] } } });
    const file = await t.request('POST', '/in', { rawBody: multipart([['f', 'bytes']], '; filename="a.txt"'), headers: ct });
    expect(file.status).toBe(415);
    const text = await t.request('POST', '/in', { rawBody: 'a=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(text.status).toBe(415);
    expect(text.body).toMatchObject({ message: expect.stringContaining('multipart/form-data') });
    expect(await t.request('POST', '/in', { body: { a: 1 } })).toMatchObject({ status: 200, body: { got: { a: 1 } } });
  });
});

describe('wildcard routes, raw bodies, all headers (NSO-297)', () => {
  it('a trailing * captures the RAW rest of the path; * elsewhere is refused', () => {
    const routes = collectRoutes((r) => {
      r.get('/:upstream/*', () => 1);
      r.get('/fixed', () => 2);
    });
    expect(matchRoute(routes, 'GET', '/echo/v1/a%2Fb/c')).toMatchObject({ kind: 'route', params: { upstream: 'echo', '*': 'v1/a%2Fb/c' } });
    expect(matchRoute(routes, 'GET', '/echo')).toMatchObject({ kind: 'route', params: { upstream: 'echo', '*': '' } });
    expect(matchRoute(routes, 'HEAD', '/echo/x')).toMatchObject({ kind: 'route', params: { '*': 'x' } });
    expect(matchRoute(routes, 'POST', '/echo/x')).toEqual({ kind: 'method_not_allowed', allow: ['GET'] });
    expect(() => normalizePattern('/*/x')).toThrow(/last segment/);
  });

  it("bodyTypes ['raw']: any content type arrives as the Buffer; handlers see every header and the raw query", async () => {
    const { defineModule, z } = await import('./index.js');
    const pass = defineModule({
      name: 'pass',
      version: '1.0.0',
      skill: { useWhen: 'x', markdown: '# x' },
      configSchema: z.object({}),
      configDefaults: {},
      routes(r) {
        r.post('/:name/*', { rule: 'public', bodyTypes: ['raw'], maxBodyBytes: 8 }, (q) => ({
          isBuffer: Buffer.isBuffer(q.body),
          text: Buffer.isBuffer(q.body) ? q.body.toString('utf8') : null,
          rest: q.params['*'],
          raw: q.rawQuery,
          custom: q.headers()['x-custom'],
        }));
      },
    });
    const t = createModuleTestContext(pass);
    const ok = await t.request('POST', '/n/a/b', {
      rawBody: 'a=1&b=2',
      query: { q: '1' },
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-custom': 'yes' },
    });
    expect(ok).toMatchObject({ status: 200, body: { isBuffer: true, text: 'a=1&b=2', rest: 'a/b', raw: 'q=1', custom: 'yes' } });
    const big = await t.request('POST', '/n/x', { rawBody: '123456789', headers: { 'content-type': 'text/plain' } });
    expect(big.status).toBe(413);
    const empty = await t.request('POST', '/n/x', {});
    expect(empty.body).toMatchObject({ isBuffer: false, text: null });
  });
});

describe("bodyTypes: ['file'] (a streamed upload)", () => {
  const B = 'xBoundary';
  const routes = collectRoutes((r) => {
    r.post('/up', { bodyTypes: ['file'] }, async (req) => {
      const f = await req.file();
      let n = 0;
      for await (const c of f.stream) n += c.length;
      return { name: f.filename, bytes: n, fields: f.fields, body: req.body ?? null };
    });
    r.post('/ignore', { bodyTypes: ['file'] }, () => ({ ok: true }));
    r.post('/json', async (req) => req.file());
  });
  const body = Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="n"\r\n\r\n1\r\n--${B}\r\nContent-Disposition: form-data; name="f"; filename="a.bin"\r\n\r\n${'z'.repeat(100_000)}\r\n--${B}--\r\n`);
  const run = async (path: string, json = false) => {
    let offset = 0;
    const state = { returned: false, readBody: false };
    const source: AsyncIterableIterator<Buffer> = {
      [Symbol.asyncIterator]: () => source,
      next: async () => {
        if (state.returned || offset >= body.length) return { value: undefined, done: true };
        const c = body.subarray(offset, offset + 1000);
        offset += c.length;
        return { value: c, done: false };
      },
      return: async () => {
        state.returned = true;
        return { value: undefined, done: true };
      },
    };
    const hit = matchRoute(routes, 'POST', path);
    if (hit.kind !== 'route') throw new Error('no route');
    const res = await runRoute(
      {
        method: 'POST',
        path,
        query: '',
        header: (n) =>
          ({ 'content-type': json ? 'application/json' : `multipart/form-data; boundary=${B}`, 'x-drobek-sdk': '1' })[n.toLowerCase()] ?? null,
        clientIp: null,
        readBody: async () => {
          state.readBody = true;
          return json ? Buffer.from('{}') : body;
        },
        bodyStream: () => source,
      },
      hit.route,
      hit.params,
      { module: 'm', selfOrigin: null, principal: async () => ({ kind: 'anon' }), context: async () => ({}) as never, limit: async () => 0 }
    );
    return { res, state, offset };
  };

  it('the handler streams the one file (text fields before it); the router never buffers the body', async () => {
    const { res, state } = await run('/up');
    expect(res.status).toBe(200);
    expect(JSON.parse(String(res.body))).toEqual({ name: 'a.bin', bytes: 100_000, fields: { n: '1' }, body: null });
    expect(state.readBody).toBe(false);
  });

  it('a handler that never reads the file: the body is returned (discarded) unread', async () => {
    const { res, state, offset } = await run('/ignore');
    expect(res.status).toBe(200);
    expect(offset).toBe(0);
    expect(state.returned).toBe(false); // never even opened
  });

  it('req.file() on a route without bodyTypes file is a programming error (500 by the runtime)', async () => {
    await expect(run('/json', true)).rejects.toThrow(/does not take a file/);
  });
});
