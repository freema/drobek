/**
 * The ONE rule evaluator every module uses (§5.0) — a pure function with
 * table tests. A rule is a `|`-separated disjunction of principals:
 *
 *   public — anyone, signed in or not
 *   user   — any end user signed in to this app
 *   owner  — a signed-in user whose id equals the record's owner (`_owner`)
 *   admin  — a signed-in user with role admin
 *   none   — nobody (the operation is closed)
 *
 * Outcome: `{ ok: true }`, or 401 (anonymous and a sign-in could help) / 403
 * (signed in but not allowed, or the rule admits nobody). An unknown token
 * makes the rule invalid — `parseRule` reports it; `decideAccess` fails closed
 * (403) on it.
 */
import type { AccessDecision, Principal, Rule } from './contract.js';

export const RULE_TOKENS = ['public', 'user', 'owner', 'admin', 'none'] as const;
export type RuleToken = (typeof RULE_TOKENS)[number];

const TOKEN_SET = new Set<string>(RULE_TOKENS);

/** The tokens of `rule`, or null when it contains an unknown/empty token. */
export function parseRule(rule: Rule): RuleToken[] | null {
  if (typeof rule !== 'string') return null;
  const parts = rule.split('|').map((p) => p.trim());
  if (parts.length === 0 || parts.some((p) => !TOKEN_SET.has(p))) return null;
  return [...new Set(parts)] as RuleToken[];
}

export function isValidRule(rule: unknown): rule is Rule {
  return typeof rule === 'string' && parseRule(rule) !== null;
}

/** Does `rule` let anyone in (`public`)? — the usual confirmRequired trigger. */
export function ruleIsPublic(rule: Rule): boolean {
  return parseRule(rule)?.includes('public') ?? false;
}

export function decideAccess(rule: Rule, principal: Principal, ownerId?: string | null): AccessDecision {
  const tokens = parseRule(rule);
  if (!tokens) return { ok: false, status: 403 };
  if (tokens.includes('public')) return { ok: true };
  if (principal.kind === 'user') {
    if (tokens.includes('user')) return { ok: true };
    if (tokens.includes('admin') && principal.role === 'admin') return { ok: true };
    if (tokens.includes('owner') && ownerId != null && ownerId === principal.id) return { ok: true };
    return { ok: false, status: 403 };
  }
  // Anonymous: a sign-in could satisfy user/owner/admin; `none` admits nobody.
  const signInHelps = tokens.some((t) => t === 'user' || t === 'owner' || t === 'admin');
  return { ok: false, status: signInHelps ? 401 : 403 };
}
