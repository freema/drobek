/**
 * The auth module's per-app config and the pure access decision (who may sign
 * in, with which role). Set by agents through `configure_module('auth', …)`;
 * opening sign-in to anyone — and enabling a sign-in provider or changing
 * who it lets in — needs the app owner's confirmation.
 *
 * `providers` (NSO-348): `emailCode` (the e-mail code, on by default) plus
 * one entry per `auth.provider` contribution of the server — `{ enabled,
 * …the provider's own config }`. The schema is COMPOSED at start from the
 * contributions (`composeAuthConfig`, the module's `compose`); the static
 * `authConfigSchema` is the one of a server without providers.
 */
import { jsonEqual, z, type AuthProvider, type ComposedModuleParts, type ConfirmItem } from '@drobek/modules';

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const email = z.string().trim().toLowerCase().max(254).pipe(z.email({ message: 'must be an e-mail address' }));
const domain = z.string().trim().toLowerCase().regex(DOMAIN_RE, 'must be a domain like example.com (no @, no scheme)');

/** The config key of the e-mail code in `providers` (the provider id `email` in rows and sessions). */
export const EMAIL_CODE_KEY = 'emailCode';

/** One provider's entry in `providers`: `enabled` + the provider's own config. */
export interface ProviderEntry {
  enabled: boolean;
  [key: string]: unknown;
}

export interface AuthConfig {
  allow: {
    /** Exact addresses that may sign in (case-insensitive). */
    emails: string[];
    /** Every address at these domains may sign in (exact domain, no subdomains). */
    domains: string[];
    /** Anyone with an e-mail address may sign in (needs the owner's confirmation). */
    anyone: boolean;
  };
  /** These addresses may sign in and are `admin`. */
  adminEmails: string[];
  /** How people sign in: the e-mail code and the server's sign-in providers (a missing provider = off). */
  providers: { emailCode: { enabled: boolean }; [id: string]: ProviderEntry | undefined };
}

const allowSchema = z.strictObject({
  emails: z.array(email).max(500),
  domains: z.array(domain).max(50),
  anyone: z.boolean(),
});

const EMAIL_CODE_DEFAULT = { enabled: true };

/**
 * One provider's entry: while disabled every field of its configSchema is
 * optional; enabling it validates the provider's whole schema.
 */
function providerEntrySchema(p: AuthProvider): z.ZodType {
  const object = p.configSchema as unknown as z.ZodObject;
  return object
    .partial()
    .extend({ enabled: z.boolean() })
    .superRefine((value, ctx) => {
      const v = value as ProviderEntry;
      if (!v.enabled) return;
      const { enabled: _enabled, ...rest } = v;
      const r = p.configSchema.safeParse(rest);
      if (!r.success) for (const issue of r.error.issues) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    });
}

function hasSignInMethod(config: Pick<AuthConfig, 'providers'>): boolean {
  if (config.providers.emailCode.enabled) return true;
  return Object.entries(config.providers).some(([key, v]) => key !== EMAIL_CODE_KEY && v?.enabled === true);
}

/** The schema without the "at least one sign-in method" rule (salvage) and with it (everything else). */
function buildSchemas(providers: readonly AuthProvider[]): { base: z.ZodType<AuthConfig>; full: z.ZodType<AuthConfig> } {
  const entries = Object.fromEntries(providers.map((p) => [p.id, providerEntrySchema(p).optional()]));
  const base = z.strictObject({
    allow: allowSchema,
    adminEmails: z.array(email).max(50),
    providers: z
      .strictObject({ [EMAIL_CODE_KEY]: z.strictObject({ enabled: z.boolean() }), ...entries })
      .default({ [EMAIL_CODE_KEY]: { ...EMAIL_CODE_DEFAULT } }),
  }) as unknown as z.ZodType<AuthConfig>;
  const full = base.superRefine((config, ctx) => {
    if (!hasSignInMethod(config)) {
      ctx.addIssue({
        code: 'custom',
        path: ['providers', EMAIL_CODE_KEY, 'enabled'],
        message: 'turn on the e-mail code or a sign-in provider — the app would have no way to sign in',
      });
    }
  });
  return { base, full };
}

/** The config schema of a server without sign-in providers. */
export const authConfigSchema: z.ZodType<AuthConfig> = buildSchemas([]).full;

export const AUTH_CONFIG_DEFAULTS: AuthConfig = {
  allow: { emails: [], domains: [], anyone: false },
  adminEmails: [],
  providers: { emailCode: { ...EMAIL_CODE_DEFAULT } },
};

function shown(value: unknown): string {
  const s = value === undefined ? 'unset' : JSON.stringify(value);
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
}

/**
 * The changes that wait for the owner (§5.0): opening sign-in to anyone,
 * enabling a sign-in provider, and changing a provider's identity fields
 * (e.g. `issuer`, `clientId` — they decide whose accounts get in) while it is
 * enabled. Turning a method OFF never waits.
 */
export function confirmRequiredFor(providers: readonly AuthProvider[]): (before: AuthConfig, after: AuthConfig) => ConfirmItem[] {
  return (before, after) => {
    const out: ConfirmItem[] = [];
    if (!before.allow.anyone && after.allow.anyone) {
      out.push('allow.anyone: false → true (anyone with an e-mail address can sign in to this app)');
    }
    for (const p of providers) {
      const b = before.providers?.[p.id];
      const a = after.providers?.[p.id];
      if (!a?.enabled) continue;
      const fields = p.identityFields ?? [];
      if (!b?.enabled) {
        const who = fields.map((f) => `${f} ${shown(a[f])}`).join(', ');
        out.push(`providers.${p.id}.enabled: false → true (people the allowlist admits can sign in with ${p.label}${who ? ` — ${who}` : ''})`);
        continue;
      }
      for (const f of fields) {
        if (!jsonEqual(b[f], a[f])) out.push(`providers.${p.id}.${f}: ${shown(b[f])} → ${shown(a[f])} (changes whose ${p.label} accounts can sign in)`);
      }
    }
    return out;
  };
}

/** Opening sign-in to anyone waits for the owner (a server without providers). */
export function authConfirmRequired(before: AuthConfig, after: AuthConfig): ConfirmItem[] {
  return confirmRequiredFor([])(before, after);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The config parts for the server's providers (the module's `compose`):
 * the schema with one `providers.<id>` entry per contribution, defaults with
 * every provider off, the confirm rules above, and a salvage for a stored
 * config that names a provider this server no longer runs (or one whose
 * stored config broke) — that provider is dropped / turned off instead of the
 * whole config falling back to the defaults. A salvaged config may leave NO
 * sign-in method on: nobody can sign in until the owner fixes it (fail
 * closed — the e-mail code is never switched back on by itself).
 */
export function composeAuthConfig(providers: readonly AuthProvider[]): ComposedModuleParts<AuthConfig> {
  const { base, full } = buildSchemas(providers);
  const ids = new Set(providers.map((p) => p.id));
  const defaults: AuthConfig = structuredClone(AUTH_CONFIG_DEFAULTS);
  for (const p of providers) defaults.providers[p.id] = { ...(p.configDefaults ?? {}), enabled: false };
  return {
    configSchema: full,
    configDefaults: defaults,
    confirmRequired: confirmRequiredFor(providers),
    salvageConfig(merged: unknown) {
      if (!isObject(merged)) return null;
      const copy = structuredClone(merged) as Record<string, unknown>;
      const issues: string[] = [];
      const stored = isObject(copy.providers) ? copy.providers : {};
      const next: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(stored)) {
        if (key === EMAIL_CODE_KEY) {
          next[key] = value;
        } else if (!ids.has(key)) {
          issues.push(`providers.${key}: no sign-in provider "${key}" runs on this server — dropped`);
        } else {
          next[key] = value;
        }
      }
      for (const p of providers) {
        const value = next[p.id];
        if (value !== undefined && !providerEntrySchema(p).safeParse(value).success) {
          next[p.id] = { ...(p.configDefaults ?? {}), enabled: false };
          issues.push(`providers.${p.id}: the stored config no longer fits the provider — turned off`);
        }
      }
      copy.providers = next;
      const r = base.safeParse(copy);
      if (!r.success) return null;
      if (!hasSignInMethod(r.data)) issues.push('providers: no sign-in method is on — nobody can sign in until the config is fixed');
      return { config: r.data, issues };
    },
  };
}

/** Is sign-in method `provider` (`email` = the e-mail code, else a provider id) on in `config`? */
export function methodEnabled(config: Pick<AuthConfig, 'providers'>, provider: string): boolean {
  if (provider === 'email') return config.providers?.emailCode?.enabled === true;
  if (provider === EMAIL_CODE_KEY || !Object.hasOwn(config.providers ?? {}, provider)) return false;
  return config.providers[provider]?.enabled === true;
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1);
}

export interface AccessInput {
  config: AuthConfig;
  /** Normalized (trimmed, lowercase). */
  email: string;
  /** Is the address an editor (or workspace-admin) of the app's workspace? */
  workspaceEditor: boolean;
}

export type AccessResult = { allowed: false } | { allowed: true; role: 'user' | 'admin' };

/**
 * May `email` sign in, and as what?
 *  - admin: listed in `adminEmails`, or an editor of the app's workspace
 *    (the people who build the app can always sign in to it);
 *  - user: `allow.anyone`, listed in `allow.emails`, or at a domain of
 *    `allow.domains`;
 *  - nobody else.
 * The same decision for every sign-in method: a provider only proves the
 * address (verified), the allowlist decides.
 */
export function decideSignIn(input: AccessInput): AccessResult {
  const { config, email } = input;
  if (input.workspaceEditor || config.adminEmails.includes(email)) return { allowed: true, role: 'admin' };
  if (config.allow.anyone || config.allow.emails.includes(email) || config.allow.domains.includes(domainOf(email))) {
    return { allowed: true, role: 'user' };
  }
  return { allowed: false };
}
