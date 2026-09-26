/**
 * The end-user sign-in providers' IdP callback on the dashboard host
 * (NSO-348): request → runtime.endUserCallback input, result → HTTP.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EndUserCallbackResult } from '@drobek/modules';

const calls: unknown[] = [];
let answer: EndUserCallbackResult = { kind: 'redirect', location: 'https://shop.apps.example/__drobek/v1/auth/complete?code=abc' };

vi.mock('@drobek/modules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@drobek/modules')>();
  return {
    ...actual,
    moduleRuntime: async () => ({
      endUserCallback: async (input: unknown) => {
        calls.push(input);
        return answer;
      },
    }),
  };
});

import { action, callbackResponse, loader, readCallbackForm } from './end-user-callback.server.js';

const URL_BASE = 'https://drobek.example/__drobek/auth/callback/oidc';

function args(request: Request, provider = 'oidc') {
  return { request, params: { provider }, context: {} } as never;
}

beforeEach(() => {
  calls.length = 0;
  answer = { kind: 'redirect', location: 'https://shop.apps.example/__drobek/v1/auth/complete?code=abc' };
});

describe('GET/POST /__drobek/auth/callback/:provider', () => {
  it('GET: the query (first value of each) goes to the runtime; a redirect is a no-store 302 without a referrer', async () => {
    const res = await loader(args(new Request(`${URL_BASE}?state=s1&state=s2&code=c&__proto__=x`, { headers: { 'x-forwarded-for': '203.0.113.9' } })));
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://shop.apps.example/__drobek/v1/auth/complete?code=abc');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Set-Cookie')).toBeNull();
    const input = calls[0] as { provider: string; method: string; query: Record<string, string>; body: unknown };
    expect(input).toMatchObject({ provider: 'oidc', method: 'GET', body: null });
    expect(input.query.state).toBe('s1');
    expect(input.query.code).toBe('c');
    expect(Object.getPrototypeOf(input.query)).toBe(Object.prototype);
    expect(Object.hasOwn(input.query, '__proto__')).toBe(true);
  });

  it('POST: a urlencoded form body is read (form_post / SAML); another content type → body null', async () => {
    const res = await action(args(new Request(URL_BASE, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, body: 'RelayState=r1&SAMLResponse=PHg%2B' })));
    expect(res.status).toBe(302);
    expect(calls[0]).toMatchObject({ method: 'POST', body: { RelayState: 'r1', SAMLResponse: 'PHg+' } });
    await action(args(new Request(URL_BASE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"state":"x"}' })));
    expect(calls[1]).toMatchObject({ method: 'POST', body: null });
  });

  it('POST: a body over 256 KiB → 413 page, the runtime is not called', async () => {
    const big = `SAMLResponse=${'a'.repeat(256 * 1024)}`;
    const res = await action(args(new Request(URL_BASE, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: big })));
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
    const streamed = await readCallbackForm(new Request(URL_BASE, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1234567890' }), 5);
    expect(streamed).toEqual({ ok: false });
  });

  it('another method → 405', async () => {
    const res = await action(args(new Request(URL_BASE, { method: 'PUT', body: 'x' })));
    expect(res.status).toBe(405);
    expect(calls).toHaveLength(0);
  });

  it('a page result → escaped HTML under a strict CSP; only an http(s) link is rendered', async () => {
    answer = { kind: 'page', status: 403, title: 'Not <allowed>', message: 'a "quote" & <script>alert(1)</script>', link: { href: 'https://shop.apps.example/?a=1&b="2"', label: 'Back' } };
    const res = await loader(args(new Request(`${URL_BASE}?state=x`)));
    expect(res.status).toBe(403);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain('Not &lt;allowed&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('href="https://shop.apps.example/?a=1&amp;b=&quot;2&quot;"');
    const js = await callbackResponse({ kind: 'page', status: 400, title: 't', message: 'm', link: { href: 'javascript:alert(1)', label: 'x' } }).text();
    expect(js).not.toContain('javascript:');
  });

  it('a redirect to a non-http location or an odd status is never passed through', async () => {
    expect(callbackResponse({ kind: 'redirect', location: 'javascript:alert(1)' }).status).toBe(500);
    expect(callbackResponse({ kind: 'page', status: 200, title: 't', message: 'm' }).status).toBe(500);
  });
});
