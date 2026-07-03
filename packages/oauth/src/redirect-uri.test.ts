import { describe, expect, it } from 'vitest';
import {
  exactRedirectUriMatch,
  isValidRegisterRedirectUri,
  isValidResource,
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

describe('isValidRegisterRedirectUri', () => {
  it('accepts absolute https', () => {
    expect(isValidRegisterRedirectUri('https://app.example/cb')).toBe(true);
  });
  it('accepts http on loopback hosts', () => {
    expect(isValidRegisterRedirectUri('http://localhost:1234/cb')).toBe(true);
    expect(isValidRegisterRedirectUri('http://127.0.0.1/cb')).toBe(true);
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
