/**
 * The proxy module's per-app config (§5.0, §5.6):
 *
 *   { upstreams: { <name>: { rules?: { call }, rateLimit? } } }
 *
 * `<name>` is an upstream REGISTERED in the app's workspace (dashboard →
 * workspace → Upstreams: base_url, allowed methods + path prefixes, the auth
 * header and its secret). The app config only ASSIGNS it to this app and says
 * who may call it:
 *
 *  - `rules.call` — `user` (default: any end user signed in to the app),
 *    `admin`, `public` (anyone, signed in or not) or `none`; alternatives
 *    joined with `|`. `owner` has no meaning here (there is no record).
 *  - `rateLimit` — calls per minute to THIS upstream from the whole app, on
 *    top of the app-wide PROXY_CALLS_PER_MIN (which always applies).
 *
 * Changes that need the owner's confirmation (confirmRequired):
 *  - assigning an upstream the app did not have (the app starts spending that
 *    upstream's secret — "povolení upstreamu appce");
 *  - opening `call` to `public` (then also limited per client IP:
 *    PROXY_PUBLIC_CALLS_PER_MIN_PER_IP).
 */
import { isValidRule, parseRule, ruleIsPublic, z } from '@drobek/modules';
import { UPSTREAM_NAME_RE } from '@drobek/proxy';

export const MAX_UPSTREAMS_PER_APP = 20;
export const DEFAULT_CALL_RULE = 'user';
/** Default app-wide proxy calls per minute (PROXY_CALLS_PER_MIN, §5.7). */
export const DEFAULT_CALLS_PER_MIN = 60;
/** Default calls per minute per client IP to a `public` upstream. */
export const DEFAULT_PUBLIC_CALLS_PER_MIN_PER_IP = 10;

const callRule = z
  .string()
  .trim()
  .max(40)
  .refine(
    (r) => isValidRule(r) && !(parseRule(r) ?? []).includes('owner'),
    'call is user, admin, public or none — alternatives joined with | (e.g. "user|admin")'
  );

export const upstreamAssignmentSchema = z.strictObject({
  /** Who may call the upstream through this app (default: signed-in users). */
  rules: z.strictObject({ call: callRule.default(DEFAULT_CALL_RULE) }).default({ call: DEFAULT_CALL_RULE }),
  /** Calls per minute to this upstream from the whole app (the app-wide limit applies too). */
  rateLimit: z.int().min(1).max(10_000).optional(),
});

export type UpstreamAssignment = z.infer<typeof upstreamAssignmentSchema>;

export const proxyConfigSchema = z.strictObject({
  upstreams: z
    .record(
      z.string().regex(UPSTREAM_NAME_RE, 'the name of an upstream registered in the workspace (letters, digits, - and _, a letter first)'),
      upstreamAssignmentSchema
    )
    .refine((u) => Object.keys(u).length <= MAX_UPSTREAMS_PER_APP, `at most ${MAX_UPSTREAMS_PER_APP} upstreams per app`)
    .default({}),
});

export type ProxyConfig = z.infer<typeof proxyConfigSchema>;

export const PROXY_CONFIG_DEFAULTS: ProxyConfig = { upstreams: {} };

/** The assignment of `name` in the app's config, or null (not assigned → 403). */
export function assignmentOf(config: ProxyConfig, name: string): UpstreamAssignment | null {
  return Object.prototype.hasOwnProperty.call(config.upstreams, name) ? config.upstreams[name] : null;
}

/** The effective call rule of an assignment. */
export function callRuleOf(a: UpstreamAssignment): string {
  return a.rules?.call ?? DEFAULT_CALL_RULE;
}

/** The changes between two valid configs that wait for the owner (see the file header). */
export function proxyConfirmRequired(before: ProxyConfig, after: ProxyConfig): string[] {
  const out: string[] = [];
  for (const name of Object.keys(after.upstreams).sort()) {
    const a = assignmentOf(after, name)!;
    const b = assignmentOf(before, name);
    const rule = callRuleOf(a);
    if (!b) {
      out.push(
        `proxy.upstreams.${name}: this app may call the workspace upstream "${name}" with its secret (callers: "${rule}")`
      );
    }
    if (ruleIsPublic(rule) && !(b && ruleIsPublic(callRuleOf(b)))) {
      out.push(
        `proxy.upstreams.${name}.rules.call: ${b ? `"${callRuleOf(b)}"` : '(new)'} → "${rule}" (anyone, signed in or not, may call it — limited per client IP)`
      );
    }
  }
  return out;
}
