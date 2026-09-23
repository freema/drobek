/**
 * The ModuleRouter pipeline through createModuleTestContext (the same
 * runRoute production uses): CSRF, rules, rate limit, validation, errors.
 */
import { describe, expect, it } from 'vitest';
import { collectRoutes, matchRoute, normalizePattern } from './router.js';
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
