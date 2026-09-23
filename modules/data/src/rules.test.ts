/**
 * The data module's access decisions — principal × rule × operation, on a
 * record owned by user A (and on one created anonymously). One row per
 * (rule, op); columns anon / A (owner) / B (another user) / admin.
 */
import { describe, expect, it } from 'vitest';
import type { Principal } from '@drobek/modules';
import { DEFAULT_RULES, LEGACY_ACCESS_MODES, OPS, accessModeToRules, decideRecord, listScope, ruleAdmits, type Op } from './access.js';

const ANON: Principal = { kind: 'anon' };
const A: Principal = { kind: 'user', id: 'eu_a', email: 'a@example.com', role: 'user' };
const B: Principal = { kind: 'user', id: 'eu_b', email: 'b@example.com', role: 'user' };
const ADMIN: Principal = { kind: 'user', id: 'eu_admin', email: 'boss@example.com', role: 'admin' };
const WHO = { anon: ANON, A, B, admin: ADMIN } as const;

type Outcome = 'ok' | 401 | 403;
type Row = [anon: Outcome, a: Outcome, b: Outcome, admin: Outcome];

function outcome(op: Op, rule: string, p: Principal, ownerId: string | null): Outcome {
  const d = decideRecord(op, rule, p, ownerId);
  return d.ok ? 'ok' : d.status;
}

function row(op: Op, rule: string, ownerId: string | null): Row {
  return [outcome(op, rule, ANON, ownerId), outcome(op, rule, A, ownerId), outcome(op, rule, B, ownerId), outcome(op, rule, ADMIN, ownerId)];
}

// get / update / delete of A's record (the stored _owner is eu_a).
const EXISTING: Record<string, Row> = {
  public: ['ok', 'ok', 'ok', 'ok'],
  user: [401, 'ok', 'ok', 'ok'],
  owner: [401, 'ok', 403, 403],
  admin: [401, 403, 403, 'ok'],
  none: [403, 403, 403, 403],
  'owner|admin': [401, 'ok', 403, 'ok'],
  'user|admin': [401, 'ok', 'ok', 'ok'],
  'public|owner': ['ok', 'ok', 'ok', 'ok'],
};

// create: the creator becomes the owner, so `owner` admits every signed-in user.
const CREATE: Record<string, Row> = {
  public: ['ok', 'ok', 'ok', 'ok'],
  user: [401, 'ok', 'ok', 'ok'],
  owner: [401, 'ok', 'ok', 'ok'],
  admin: [401, 403, 403, 'ok'],
  none: [403, 403, 403, 403],
  'owner|admin': [401, 'ok', 'ok', 'ok'],
};

describe('decideRecord: principal × rule × op', () => {
  for (const op of ['read', 'update', 'delete'] as const) {
    for (const [rule, expected] of Object.entries(EXISTING)) {
      it(`${op} "${rule}" on A's record → anon ${expected[0]}, A ${expected[1]}, B ${expected[2]}, admin ${expected[3]}`, () => {
        expect(row(op, rule, 'eu_a')).toEqual(expected);
      });
    }
  }
  for (const [rule, expected] of Object.entries(CREATE)) {
    it(`create "${rule}" → anon ${expected[0]}, A ${expected[1]}, B ${expected[2]}, admin ${expected[3]}`, () => {
      expect(row('create', rule, null)).toEqual(expected);
    });
  }

  it('an anonymous record (no _owner) is nobody\'s: `owner` never matches it', () => {
    expect(row('update', 'owner', null)).toEqual([401, 403, 403, 403]);
    expect(row('delete', 'owner|admin', null)).toEqual([401, 403, 403, 'ok']);
  });

  it('create ignores any owner passed in (the server sets it from the principal)', () => {
    expect(outcome('create', 'owner', B, 'eu_a')).toBe('ok');
    expect(outcome('create', 'owner', ANON, 'eu_a')).toBe(401);
  });

  it('a malformed rule admits nobody (403)', () => {
    for (const p of Object.values(WHO)) expect(outcome('read', 'everyone', p, 'eu_a')).toBe(403);
  });
});

describe('listScope: what a list returns', () => {
  const scope = (rule: string, p: Principal) => {
    const s = listScope(rule, p);
    return s.ok ? (s.ownerId === null ? 'all' : `own:${s.ownerId}`) : s.status;
  };
  const TABLE: Record<string, [anon: unknown, a: unknown, b: unknown, admin: unknown]> = {
    public: ['all', 'all', 'all', 'all'],
    user: [401, 'all', 'all', 'all'],
    owner: [401, 'own:eu_a', 'own:eu_b', 'own:eu_admin'],
    'owner|admin': [401, 'own:eu_a', 'own:eu_b', 'all'],
    admin: [401, 403, 403, 'all'],
    none: [403, 403, 403, 403],
  };
  for (const [rule, expected] of Object.entries(TABLE)) {
    it(`read "${rule}" → ${expected.join(' / ')}`, () => {
      expect([scope(rule, ANON), scope(rule, A), scope(rule, B), scope(rule, ADMIN)]).toEqual(expected);
    });
  }
});

describe('legacy access modes → rules', () => {
  it('maps the four modes exactly', () => {
    expect(accessModeToRules('public-read')).toEqual({ read: 'public', create: 'admin', update: 'admin', delete: 'admin' });
    expect(accessModeToRules('public-write')).toEqual({ read: 'public', create: 'public', update: 'admin', delete: 'admin' });
    expect(accessModeToRules('locked')).toEqual({ read: 'admin', create: 'admin', update: 'admin', delete: 'admin' });
    expect(accessModeToRules('owner-only')).toEqual({ read: 'owner|admin', create: 'user', update: 'owner|admin', delete: 'owner|admin' });
    expect(LEGACY_ACCESS_MODES).toHaveLength(4);
  });

  it('public-write: visitors read and add, only admins change or delete', () => {
    const r = accessModeToRules('public-write');
    expect(OPS.map((op) => outcome(op, r[op], ANON, null))).toEqual(['ok', 'ok', 401, 401]);
    expect(OPS.map((op) => outcome(op, r[op], ADMIN, null))).toEqual(['ok', 'ok', 'ok', 'ok']);
  });

  it('the default rules are the owner-only mapping', () => {
    expect(DEFAULT_RULES).toEqual(accessModeToRules('owner-only'));
  });
});

describe('ruleAdmits', () => {
  it('matches a token of the disjunction', () => {
    expect(ruleAdmits('public|owner', 'public')).toBe(true);
    expect(ruleAdmits('owner|admin', 'user')).toBe(false);
    expect(ruleAdmits('user', 'user')).toBe(true);
    expect(ruleAdmits(undefined, 'public')).toBe(false);
  });
});
