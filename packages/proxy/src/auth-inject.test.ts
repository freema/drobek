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
    expect(out['location']).toBe('https://elsewhere.example/');
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
