/**
 * The auth module's two slots (NSO-348) as the module reads them:
 *
 *   `auth.provider` — sign-in providers (`AuthProvider` from @drobek/modules);
 *   `auth.signedIn` — observers of successful sign-ins.
 *
 * Plus what a provider call gets from `auth`: its config (the app's
 * `providers.<id>` without `enabled`), its secrets (its own declared names:
 * the app's value, else the operator's `AUTH_<ID>_…` env fallback it
 * declared) and the operator's `AUTH_<ID>_*` env vars, and the time limits
 * of provider and observer calls.
 */
import type { Logger } from '@drobek/core';
import type { AuthProvider, AuthProviderSecrets, AuthSignInEvent, AuthSignedInObserver } from '@drobek/modules';
import { EMAIL_CODE_KEY, methodEnabled, type AuthConfig } from './config.js';

export const PROVIDER_SLOT = 'auth.provider';
export const SIGNED_IN_SLOT = 'auth.signedIn';

/** A provider's begin / callback is cut off after this long (`provider_error`). */
export const PROVIDER_CALL_TIMEOUT_MS = 15_000;
/** An `auth.signedIn` observer is cut off after this long (logged). */
export const OBSERVER_TIMEOUT_MS = 5_000;

/** What `<LoginGate>` and `drobek.auth.providers()` list: the e-mail code (`emailCode`) and each enabled provider. */
export interface SignInMethod {
  id: string;
  label: string;
}

type Contributions = <T = unknown>(slot: string) => T[];

/** The enabled provider `id` of this app (a contribution of the server whose `providers.<id>.enabled` is true), or null. */
export function enabledProvider(contributions: Contributions, config: AuthConfig, id: string): AuthProvider | null {
  if (!methodEnabled(config, id)) return null;
  return contributions<AuthProvider>(PROVIDER_SLOT).find((p) => p.id === id) ?? null;
}

/** The sign-in methods that are on for the app, in DROBEK_MODULES order after the e-mail code. */
export function signInMethods(contributions: Contributions, config: AuthConfig): SignInMethod[] {
  const out: SignInMethod[] = [];
  if (methodEnabled(config, 'email')) out.push({ id: EMAIL_CODE_KEY, label: 'E-mail code' });
  for (const p of contributions<AuthProvider>(PROVIDER_SLOT)) {
    if (methodEnabled(config, p.id)) out.push({ id: p.id, label: p.label });
  }
  return out;
}

/** The provider's own part of the app's config: `providers.<id>` without `enabled`. */
export function providerConfig(config: AuthConfig, id: string): Record<string, unknown> {
  const { enabled: _enabled, ...rest } = config.providers[id] ?? { enabled: false };
  return rest;
}

/** The operator's `AUTH_<ID>_*` env vars (non-empty ones), for a provider's own env fallback. */
export function providerEnv(id: string, env: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  const prefix = `AUTH_${id.toUpperCase()}_`;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith(prefix) && typeof v === 'string' && v.trim() !== '') out[k] = v;
  }
  return Object.freeze(out);
}

/**
 * The provider's secrets for one app: only the names IT declared; the app's
 * value (the auth module's secret, set in the dashboard) first, else the
 * declared `AUTH_<ID>_…` env var. Never another provider's secret.
 */
export function providerSecrets(
  provider: AuthProvider,
  appSecret: (name: string) => Promise<string | null>,
  env: NodeJS.ProcessEnv = process.env
): AuthProviderSecrets {
  const docs = new Map((provider.secrets ?? []).map((s) => [s.name, s]));
  return {
    async get(name) {
      const doc = docs.get(name);
      if (!doc) throw new Error(`auth provider "${provider.id}" reads undeclared secret "${name}"`);
      const own = await appSecret(name);
      if (own) return own;
      const fallback = doc.env ? env[doc.env]?.trim() : '';
      return fallback || null;
    },
  };
}

/** An error's NAME only — a provider's or observer's message may quote tokens, IdP answers or addresses. */
export function errorKind(err: unknown): string {
  if (err instanceof Error) return err.name || 'Error';
  return typeof err;
}

/** `work`, or a rejection (`TimeoutError`) after `ms`. */
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`timed out after ${ms} ms`);
      e.name = 'TimeoutError';
      reject(e);
    }, ms);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Tell every `auth.signedIn` observer about a successful sign-in — in
 * parallel, each cut off after OBSERVER_TIMEOUT_MS. A failure or timeout is
 * logged (the observer id and the error's name) and never reaches the
 * caller: the returned promise always resolves. The routes do not await it
 * (the sign-in answers at once).
 */
export async function notifySignedIn(
  observers: readonly AuthSignedInObserver[],
  event: AuthSignInEvent,
  log: Logger = event.log,
  timeoutMs = OBSERVER_TIMEOUT_MS
): Promise<void> {
  await Promise.all(
    observers.map(async (o) => {
      try {
        await withTimeout(Promise.resolve().then(() => o.onSignIn(event)), timeoutMs);
      } catch (err) {
        log.warn('auth: sign-in observer failed', { observer: o.id, app_id: event.app.id, provider: event.provider, error: errorKind(err) });
      }
    })
  );
}
