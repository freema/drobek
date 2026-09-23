import { describe, expect, it } from 'vitest';
import { canConfigureUpstreams } from './authz.js';

describe('canConfigureUpstreams — admin-only', () => {
  it('allows workspace-admin + super-admin', () => {
    expect(canConfigureUpstreams('workspace-admin')).toBe(true);
    expect(canConfigureUpstreams(null, true)).toBe(true);
    expect(canConfigureUpstreams('viewer', true)).toBe(true); // super-admin override
  });
  it('denies editor / viewer / non-member', () => {
    expect(canConfigureUpstreams('editor')).toBe(false);
    expect(canConfigureUpstreams('viewer')).toBe(false);
    expect(canConfigureUpstreams(null)).toBe(false);
  });
});
