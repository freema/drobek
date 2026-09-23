import { describe, expect, it } from 'vitest';
import { decideAccess, isValidRule, parseRule, ruleIsPublic } from './rules.js';

const anon = { kind: 'anon' } as const;
const user = { kind: 'user', id: 'u1', email: 'u@example.com', role: 'user' } as const;
const admin = { kind: 'user', id: 'a1', email: 'a@example.com', role: 'admin' } as const;

describe('rules', () => {
  it('parses | alternatives and rejects unknown tokens', () => {
    expect(parseRule('owner|admin')).toEqual(['owner', 'admin']);
    expect(parseRule('owner|root')).toBeNull();
    expect(isValidRule('user')).toBe(true);
    expect(isValidRule('')).toBe(false);
    expect(ruleIsPublic('public')).toBe(true);
    expect(ruleIsPublic('user|public')).toBe(true);
    expect(ruleIsPublic('user')).toBe(false);
  });

  it('decides 401 for anon on a sign-in rule, 403 otherwise', () => {
    expect(decideAccess('public', anon)).toEqual({ ok: true });
    expect(decideAccess('user', anon)).toEqual({ ok: false, status: 401 });
    expect(decideAccess('none', anon)).toEqual({ ok: false, status: 403 });
    expect(decideAccess('user', user)).toEqual({ ok: true });
    expect(decideAccess('admin', user)).toEqual({ ok: false, status: 403 });
    expect(decideAccess('admin', admin)).toEqual({ ok: true });
    expect(decideAccess('owner', user, 'u1')).toEqual({ ok: true });
    expect(decideAccess('owner', user, 'u2')).toEqual({ ok: false, status: 403 });
    expect(decideAccess('owner|admin', admin, 'u2')).toEqual({ ok: true });
    expect(decideAccess('bogus', admin)).toEqual({ ok: false, status: 403 });
  });
});
