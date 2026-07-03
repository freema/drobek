import { describe, expect, it } from 'vitest';
import { DEFAULT_SCOPES, hasScope, parseScopes } from './scopes.js';

describe('parseScopes', () => {
  it('keeps only known scopes, deduped', () => {
    expect(parseScopes('apps:read apps:read data:read bogus')).toEqual([
      'apps:read',
      'data:read',
    ]);
  });

  it('falls back to the default baseline when empty or all-unknown', () => {
    expect(parseScopes('')).toEqual([...DEFAULT_SCOPES]);
    expect(parseScopes(null)).toEqual([...DEFAULT_SCOPES]);
    expect(parseScopes('totally unknown')).toEqual([...DEFAULT_SCOPES]);
  });
});

describe('hasScope', () => {
  it('detects a granted scope in a space-delimited string', () => {
    expect(hasScope('mcp:whoami apps:read', 'apps:read')).toBe(true);
    expect(hasScope('mcp:whoami', 'apps:read')).toBe(false);
    expect(hasScope(null, 'apps:read')).toBe(false);
  });
});
