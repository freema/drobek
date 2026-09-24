import { describe, expect, it } from 'vitest';
import { DEFAULT_DOMAINS_MAX_PER_APP, domainsConfigError, domainsMaxPerApp } from './index.js';

describe('DOMAINS_MAX_PER_APP (NSO-329)', () => {
  it('defaults to 3; 0 is valid and means custom domains are off', () => {
    expect(domainsMaxPerApp({})).toBe(DEFAULT_DOMAINS_MAX_PER_APP);
    expect(DEFAULT_DOMAINS_MAX_PER_APP).toBe(3);
    expect(domainsMaxPerApp({ DOMAINS_MAX_PER_APP: '0' })).toBe(0);
    expect(domainsMaxPerApp({ DOMAINS_MAX_PER_APP: '5' })).toBe(5);
    expect(domainsMaxPerApp({ DOMAINS_MAX_PER_APP: '-1' })).toBe(3);
  });

  it('the startup check accepts 0 and refuses a negative or non-integer value', () => {
    expect(domainsConfigError({ DOMAINS_MAX_PER_APP: '0' })).toBeNull();
    expect(domainsConfigError({ DOMAINS_MAX_PER_APP: '2' })).toBeNull();
    expect(domainsConfigError({ DOMAINS_MAX_PER_APP: '-1' })).toMatch(/DOMAINS_MAX_PER_APP must be a whole number/);
    expect(domainsConfigError({ DOMAINS_MAX_PER_APP: '1.5' })).toMatch(/DOMAINS_MAX_PER_APP/);
  });
});
