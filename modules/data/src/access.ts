/**
 * Who may do what with a collection's records (§5.0) — PURE decisions over
 * the ONE rule evaluator of @drobek/modules (`decideAccess`), table-tested in
 * rules.test.ts. Per collection, each operation has a rule:
 *
 *   read   — list and get records
 *   create — add a record (its `_owner` is the signed-in creator, or null)
 *   update — change a record's fields
 *   delete — remove a record
 *
 * `owner` compares the STORED `_owner` of the record (set by the server at
 * create time, never by a client). For a list, `owner` narrows the result to
 * the caller's own records instead of refusing it: a signed-in user under
 * `read: "owner|admin"` lists exactly their records, an admin lists all.
 */
import { decideAccess, parseRule, type AccessDecision, type Principal, type Rule } from '@drobek/modules';

export const OPS = ['read', 'create', 'update', 'delete'] as const;
export type Op = (typeof OPS)[number];

export type Rules = Record<Op, Rule>;

/**
 * A declared collection without rules: private to each signed-in user —
 * users create records and see/change only their own; the app's admins see
 * and change everything; visitors nothing.
 */
export const DEFAULT_RULES: Rules = Object.freeze({
  read: 'owner|admin',
  create: 'user',
  update: 'owner|admin',
  delete: 'owner|admin',
});

/** The pre-module Data API access modes (U10) → per-operation rules (the migration does the same in SQL). */
export const LEGACY_ACCESS_MODES = ['public-read', 'public-write', 'locked', 'owner-only'] as const;
export type LegacyAccessMode = (typeof LEGACY_ACCESS_MODES)[number];

export function accessModeToRules(mode: LegacyAccessMode): Rules {
  switch (mode) {
    case 'public-read':
      return { read: 'public', create: 'admin', update: 'admin', delete: 'admin' };
    case 'public-write':
      return { read: 'public', create: 'public', update: 'admin', delete: 'admin' };
    case 'locked':
      return { read: 'admin', create: 'admin', update: 'admin', delete: 'admin' };
    case 'owner-only':
      return { read: 'owner|admin', create: 'user', update: 'owner|admin', delete: 'owner|admin' };
  }
}

/**
 * One record operation: `ownerId` is the stored `_owner` of the record
 * (get / update / delete). A create passes no owner: the creator becomes the
 * owner, so `owner` admits any signed-in creator.
 */
export function decideRecord(op: Op, rule: Rule, principal: Principal, ownerId: string | null): AccessDecision {
  if (op === 'create') return decideAccess(rule, principal, principal.kind === 'user' ? principal.id : null);
  return decideAccess(rule, principal, ownerId);
}

/** What a list may return: every record, only the caller's own, or nothing (401/403). */
export type ListScope = { ok: true; ownerId: string | null } | { ok: false; status: 401 | 403 };

export function listScope(rule: Rule, principal: Principal): ListScope {
  const d = decideAccess(rule, principal, null);
  if (d.ok) return { ok: true, ownerId: null };
  if (principal.kind === 'user' && parseRule(rule)?.includes('owner')) return { ok: true, ownerId: principal.id };
  return d;
}

/** Does `rule` admit this token (e.g. `user` for "any signed-in user")? */
export function ruleAdmits(rule: Rule | undefined, token: 'public' | 'user'): boolean {
  return rule !== undefined && (parseRule(rule)?.includes(token) ?? false);
}
