import { describe, expect, it } from 'vitest';
import {
  buildForwardHeaders,
  filterResponseHeaders,
} from './auth-inject.js';
import { ProxyError } from './errors.js';

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

describe('buildForwardHeaders — auth injection shape', () => {
  it('bearer → Authorization: Bearer <secret>', () => {
    const out = buildForwardHeaders(headers({ accept: 'application/json' }), {
      authType: 'bearer',
      secret: 's3cr3t',
    });
    expect(out['authorization']).toBe('Bearer s3cr3t');
    expect(out['accept']).toBe('application/json');
  });

  it('header → <name>: <secret> (lower-cased)', () => {
    const out = buildForwardHeaders(headers({}), {
      authType: 'header',
      authHeaderName: 'X-Api-Key',
      secret: 'abc123',
    });
    expect(out['x-api-key']).toBe('abc123');
  });

  it('none → injects nothing', () => {
    const out = buildForwardHeaders(headers({ accept: '*/*' }), {
      authType: 'none',
    });
    expect(out['authorization']).toBeUndefined();
    expect(out['accept']).toBe('*/*');
  });

  it('fails closed when a secret/header-name is missing', () => {
    expect(() =>
      buildForwardHeaders(headers({}), { authType: 'bearer', secret: '' })
    ).toThrow(ProxyError);
    expect(() =>
      buildForwardHeaders(headers({}), { authType: 'header', secret: 'x' })
    ).toThrow(ProxyError);
  });
});

describe('buildForwardHeaders — strips client credentials + hop-by-hop', () => {
  it('drops the client Authorization AND Cookie (drobek session never leaks)', () => {
    const out = buildForwardHeaders(
      headers({
        authorization: 'Bearer CLIENT-TOKEN',
        cookie: 'drobek_session=deadbeef',
        accept: 'application/json',
      }),
      { authType: 'none' }
    );
    expect(out['authorization']).toBeUndefined();
    expect(out['cookie']).toBeUndefined();
    expect(out['accept']).toBe('application/json');
  });

  it('the injected auth OVERWRITES a client-supplied Authorization', () => {
    const out = buildForwardHeaders(
      headers({ authorization: 'Bearer CLIENT-TOKEN' }),
      { authType: 'bearer', secret: 'REAL' }
    );
    expect(out['authorization']).toBe('Bearer REAL');
  });

  it('drops hop-by-hop + host + forwarding headers', () => {
    const out = buildForwardHeaders(
      headers({
        host: 'evil.example',
        connection: 'keep-alive',
        'transfer-encoding': 'chunked',
        'x-forwarded-for': '10.0.0.1',
        'content-length': '10',
      }),
      { authType: 'none' }
    );
    expect(out['host']).toBeUndefined();
    expect(out['connection']).toBeUndefined();
    expect(out['transfer-encoding']).toBeUndefined();
    expect(out['x-forwarded-for']).toBeUndefined();
    expect(out['content-length']).toBeUndefined();
  });
});

describe('buildForwardHeaders — browser metadata never reaches the upstream (NSO-297)', () => {
  it('drops origin / referer / sec-* / x-drobek-sdk / forwarded / via; asks for identity encoding', () => {
    const out = buildForwardHeaders(
      headers({
        origin: 'https://notes.apps.example',
        referer: 'https://notes.apps.example/page',
        'sec-fetch-site': 'same-origin',
        'sec-ch-ua': '"Chromium"',
        'x-drobek-sdk': '1',
        forwarded: 'for=1.2.3.4',
        via: '1.1 caddy',
        'x-forwarded-port': '443',
        'accept-encoding': 'gzip, br',
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      }),
      { authType: 'bearer', secret: 'S' }
    );
    for (const gone of ['origin', 'referer', 'sec-fetch-site', 'sec-ch-ua', 'x-drobek-sdk', 'forwarded', 'via', 'x-forwarded-port']) {
      expect(out[gone], gone).toBeUndefined();
    }
    expect(out['accept-encoding']).toBe('identity');
    expect(out['content-type']).toBe('application/json');
    expect(out['anthropic-version']).toBe('2023-06-01');
    expect(out['authorization']).toBe('Bearer S');
  });
});

describe('filterResponseHeaders', () => {
  it("strips the upstream's CORS grants (NSO-297)", () => {
    const out = filterResponseHeaders([
      ['content-type', 'text/plain'],
      ['Access-Control-Allow-Origin', '*'],
      ['access-control-allow-credentials', 'true'],
      ['location', 'https://elsewhere.example/'],
    ]);
    expect(out['Access-Control-Allow-Origin']).toBeUndefined();
    expect(out['access-control-allow-credentials']).toBeUndefined();
    // An absolute Location is dropped (NSO-326).
    expect(out['location']).toBeUndefined();
    expect(out['content-type']).toBe('text/plain');
  });

  it('strips hop-by-hop + set-cookie from the upstream response', () => {
    const out = filterResponseHeaders([
      ['content-type', 'application/json'],
      ['set-cookie', 'x=1'],
      ['transfer-encoding', 'chunked'],
      ['content-encoding', 'gzip'],
    ]);
    expect(out['content-type']).toBe('application/json');
    expect(out['set-cookie']).toBeUndefined();
    expect(out['transfer-encoding']).toBeUndefined();
    expect(out['content-encoding']).toBeUndefined();
  });
});

describe('filterResponseHeaders — an allow-list (NSO-326)', () => {
  const filter = (h: Record<string, string>) => filterResponseHeaders(Object.entries(h));

  it('drops every header that would act on the app origin', () => {
    const dropped = {
      'Clear-Site-Data': '"cache", "cookies", "storage"',
      Refresh: '0; url=https://evil.example/',
      Link: '<https://evil.example/x.js>; rel=preload; as=script',
      'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
      'Service-Worker-Allowed': '/',
      'Set-Cookie': 'up=1; Path=/',
      'Set-Cookie2': 'up=1',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': '*',
      'Content-Security-Policy': "default-src *",
      'X-Frame-Options': 'ALLOWALL',
      'WWW-Authenticate': 'Bearer realm="internal"',
      'Alt-Svc': 'h3=":443"',
      'Content-Location': 'https://upstream.internal/v1/x',
      Server: 'upstream/1.0',
      'X-Powered-By': 'Express',
      'Transfer-Encoding': 'chunked',
      Connection: 'keep-alive',
      'Content-Length': '12',
      'Content-Encoding': 'gzip',
    };
    expect(filter(dropped)).toEqual({});
  });

  it('keeps the representation, caching, rate-limit and request-id headers', () => {
    const kept = {
      'Content-Type': 'application/json',
      'Content-Language': 'en',
      'Content-Range': 'bytes 0-9/100',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'max-age=60',
      Expires: 'Wed, 21 Oct 2026 07:28:00 GMT',
      Pragma: 'no-cache',
      ETag: '"abc"',
      'Last-Modified': 'Wed, 21 Oct 2026 07:28:00 GMT',
      Vary: 'Accept',
      Date: 'Wed, 21 Oct 2026 07:28:00 GMT',
      Age: '3',
      'Retry-After': '30',
      'X-Request-Id': 'req_1',
      'X-Correlation-Id': 'c_1',
      'X-Trace-Id': 't_1',
      'Request-Id': 'r_1',
      'x-amzn-RequestId': 'a_1',
      'X-RateLimit-Remaining-Requests': '99',
      'RateLimit-Limit': '100',
      RateLimit: 'limit=100, remaining=99',
      'RateLimit-Policy': '100;w=60',
    };
    expect(filter(kept)).toEqual(kept);
  });

  it('Location: a relative reference passes, anything absolute (or browser-absolute) is dropped', () => {
    for (const rel of ['/v1/items/2', 'items/2', '../x?y=1', '?page=2', '#top']) {
      expect(filter({ Location: rel }), rel).toEqual({ Location: rel });
    }
    for (const abs of [
      'https://api.upstream.example/v1/items/2',
      'http://169.254.169.254/latest/meta-data/',
      '//evil.example/x',
      '/\\evil.example/x',
      'javascript:alert(1)',
      'HTTPS://api.upstream.example/',
      '/x\r\nSet-Cookie: a=1',
      '',
    ]) {
      expect(filter({ Location: abs }), abs).toEqual({});
    }
  });

  it('Content-Disposition passes for non-HTML answers only', () => {
    expect(filter({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="a.pdf"' })).toEqual({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="a.pdf"',
    });
    expect(filter({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': 'inline; filename="x.html"' })).toEqual({
      'Content-Type': 'text/html; charset=utf-8',
    });
    expect(filter({ 'content-disposition': 'attachment', 'content-type': 'application/xhtml+xml' })).toEqual({
      'content-type': 'application/xhtml+xml',
    });
  });
});
