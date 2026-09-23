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
    expect(ok.body).toEqual({ greeting: 'hi', principal: 'user', hasToken: true });
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
