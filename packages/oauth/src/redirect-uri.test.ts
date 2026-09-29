import { describe, expect, it } from 'vitest';
import {
  exactRedirectUriMatch,
  isValidRegisterRedirectUri,
  isValidResource,
  registeredRedirectUriMatch,
} from './redirect-uri.js';

describe('exactRedirectUriMatch', () => {
  const registered = ['https://client.example/cb', 'http://localhost:9999/callback'];

  it('accepts an exact string match', () => {
    expect(exactRedirectUriMatch('https://client.example/cb', registered)).toBe(true);
    expect(exactRedirectUriMatch('http://localhost:9999/callback', registered)).toBe(true);
  });

  it('rejects a prefix / substring', () => {
    expect(exactRedirectUriMatch('https://client.example', registered)).toBe(false);
    expect(exactRedirectUriMatch('https://client.example/cb/extra', registered)).toBe(false);
  });

  it('rejects a trailing-slash variant', () => {
    expect(exactRedirectUriMatch('https://client.example/cb/', registered)).toBe(false);
  });

  it('rejects an added query string', () => {
    expect(exactRedirectUriMatch('https://client.example/cb?x=1', registered)).toBe(false);
  });

  it('rejects an evil look-alike host', () => {
    expect(exactRedirectUriMatch('https://client.example.evil.com/cb', registered)).toBe(false);
  });
});

describe('registeredRedirectUriMatch (RFC 8252 §7.3 loopback ports)', () => {
  const cimd = ['http://localhost/callback', 'http://127.0.0.1/callback'];

  it('accepts a port-less registered loopback URI with any port (Claude Code CIMD)', () => {
    expect(registeredRedirectUriMatch('http://localhost:55537/callback', cimd)).toBe(true);
    expect(registeredRedirectUriMatch('http://127.0.0.1:1/callback', cimd)).toBe(true);
    expect(registeredRedirectUriMatch('http://localhost/callback', cimd)).toBe(true);
  });

  it('accepts a different port than a registered loopback port, and IPv6 loopback', () => {
    expect(registeredRedirectUriMatch('http://localhost:4000/cb', ['http://localhost:9999/cb'])).toBe(true);
    expect(registeredRedirectUriMatch('http://[::1]:4000/cb', ['http://[::1]/cb'])).toBe(true);
  });

  it('still rejects a different path, query, host or scheme', () => {
    expect(registeredRedirectUriMatch('http://localhost:55537/callback/', cimd)).toBe(false);
    expect(registeredRedirectUriMatch('http://localhost:55537/other', cimd)).toBe(false);
    expect(registeredRedirectUriMatch('http://localhost:55537/callback?x=1', cimd)).toBe(false);
    expect(registeredRedirectUriMatch('http://localhost:55537/callback#x', cimd)).toBe(false);
    expect(registeredRedirectUriMatch('http://127.0.0.1:55537/cb', ['http://localhost/cb'])).toBe(false);
    expect(registeredRedirectUriMatch('https://localhost:55537/callback', cimd)).toBe(false);
    expect(registeredRedirectUriMatch('http://localhost.evil.com:55537/callback', cimd)).toBe(false);
    expect(registeredRedirectUriMatch('http://user@localhost:55537/callback', cimd)).toBe(false);
    expect(registeredRedirectUriMatch('http://localhost:70000/callback', cimd)).toBe(false);
  });

  it('keeps https to an exact match, port included', () => {
    expect(registeredRedirectUriMatch('https://client.example:8443/cb', ['https://client.example/cb'])).toBe(false);
    expect(registeredRedirectUriMatch('https://client.example/cb', ['https://client.example/cb'])).toBe(true);
  });
});

describe('isValidRegisterRedirectUri', () => {
  it('accepts absolute https', () => {
    expect(isValidRegisterRedirectUri('https://app.example/cb')).toBe(true);
  });
  it('accepts http on loopback hosts', () => {
    expect(isValidRegisterRedirectUri('http://localhost:1234/cb')).toBe(true);
    expect(isValidRegisterRedirectUri('http://127.0.0.1/cb')).toBe(true);
    expect(isValidRegisterRedirectUri('http://[::1]:8080/cb')).toBe(true);
  });
  it('rejects http on non-loopback hosts', () => {
    expect(isValidRegisterRedirectUri('http://evil.example/cb')).toBe(false);
  });
  it('rejects relative and fragment-bearing URIs', () => {
    expect(isValidRegisterRedirectUri('/cb')).toBe(false);
    expect(isValidRegisterRedirectUri('https://app.example/cb#frag')).toBe(false);
  });
});

describe('isValidResource', () => {
  it('accepts absolute URIs', () => {
    expect(isValidResource('https://mcp.drobek.app')).toBe(true);
    expect(isValidResource('http://localhost:3042')).toBe(true);
  });
  it('rejects relative or fragment URIs', () => {
    expect(isValidResource('mcp')).toBe(false);
    expect(isValidResource('https://mcp.drobek.app#x')).toBe(false);
  });
});
