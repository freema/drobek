import { describe, expect, it } from 'vitest';
import { mayHoldAccount, personalInstance, personalInstanceConfigError, personalOwnerEmail } from './personal.server.js';

const PATH = {
  APPS_ROUTING_MODE: 'path',
  APPS_BASE_URL: 'https://apps-xyz.up.railway.app',
  PUBLIC_APP_URL: 'https://drobek-abc.up.railway.app',
  NODE_ENV: 'production',
  SUPERADMIN_EMAIL: 'Owner@Example.com',
};

describe('personal instance', () => {
  it('is path routing; subdomain routing stays a shared server', () => {
    expect(personalInstance(PATH)).toBe(true);
    expect(personalInstance({ APPS_DOMAIN: 'drobek.app', SUPERADMIN_EMAIL: 'a@x.com,b@x.com' })).toBe(false);
    expect(mayHoldAccount('anyone@example.com', { APPS_DOMAIN: 'drobek.app' })).toBe(true);
    expect(personalInstanceConfigError({ APPS_DOMAIN: 'drobek.app', SUPERADMIN_EMAIL: 'a@x.com,b@x.com' })).toBeNull();
  });

  it('lets only the single owner hold an account', () => {
    expect(personalOwnerEmail(PATH)).toBe('owner@example.com');
    expect(mayHoldAccount('owner@example.com', PATH)).toBe(true);
    expect(mayHoldAccount(' OWNER@example.com ', PATH)).toBe(true);
    expect(mayHoldAccount('other@example.com', PATH)).toBe(false);
    expect(mayHoldAccount('owner@example.com.evil.com', PATH)).toBe(false);
  });

  it('refuses to start without exactly one SUPERADMIN_EMAIL', () => {
    expect(personalInstanceConfigError(PATH)).toBeNull();
    expect(personalInstanceConfigError({ ...PATH, SUPERADMIN_EMAIL: '' })).toMatch(/exactly one SUPERADMIN_EMAIL/);
    expect(personalInstanceConfigError({ ...PATH, SUPERADMIN_EMAIL: 'a@x.com, b@x.com' })).toMatch(/exactly one SUPERADMIN_EMAIL/);
    // Without an owner nobody may hold an account.
    expect(mayHoldAccount('a@x.com', { ...PATH, SUPERADMIN_EMAIL: 'a@x.com,b@x.com' })).toBe(false);
  });
});
