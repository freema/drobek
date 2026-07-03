import { describe, expect, it } from 'vitest';
import { decideVisibility, type Visibility } from './visibility.js';

const ANON = { isMember: false, isSuperAdmin: false, hasAppAccess: false };
const MEMBER = { isMember: true, isSuperAdmin: false, hasAppAccess: false };
const SUPER = { isMember: false, isSuperAdmin: true, hasAppAccess: false };
const WITH_COOKIE = { isMember: false, isSuperAdmin: false, hasAppAccess: true };

function decide(visibility: Visibility, who: typeof ANON) {
  return decideVisibility({ visibility, ...who }).action;
}

describe('decideVisibility — public', () => {
  it('always serves', () => {
    expect(decide('public', ANON)).toBe('serve');
    expect(decide('public', MEMBER)).toBe('serve');
  });
});

describe('decideVisibility — team (anti-enumeration 404)', () => {
  it('serves members and super-admins', () => {
    expect(decide('team', MEMBER)).toBe('serve');
    expect(decide('team', SUPER)).toBe('serve');
  });
  it('404s anonymous and non-members (no existence leak)', () => {
    expect(decide('team', ANON)).toBe('not-found');
  });
});

describe('decideVisibility — password', () => {
  it('serves with a valid app-access cookie', () => {
    expect(decide('password', WITH_COOKIE)).toBe('serve');
  });
  it('owners (member / super-admin) bypass the password', () => {
    expect(decide('password', MEMBER)).toBe('serve');
    expect(decide('password', SUPER)).toBe('serve');
  });
  it('shows the password page with no cookie and no membership', () => {
    expect(decide('password', ANON)).toBe('password');
  });
});
