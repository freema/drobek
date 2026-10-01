/**
 * Which transport carries the operator's outgoing mail — one switch for the
 * dashboard (sign-in codes, invites, abuse notices) and the platform modules'
 * `ctx.email.send`: `EMAIL_TRANSPORT=smtp` (default, nodemailer), `resend`
 * (the Resend HTTP API over `fetch`, needs `RESEND_API_KEY`) or the id of a
 * transport a module contributes to the `email.transport` slot
 * (module-transport.server.ts; the module runtime checks it at start). The
 * rate limits (OTP_*, EMAIL_GLOBAL_* …) live above this layer and apply to all.
 */

/** The built-in transports; a module transport may not take their ids. */
export const BUILTIN_EMAIL_TRANSPORTS = ['smtp', 'resend'] as const;

/** Module transport ids: lowercase letters and digits, 2–16 characters (the value of EMAIL_TRANSPORT). */
export const EMAIL_TRANSPORT_ID_RE = /^[a-z][a-z0-9]{1,15}$/;

/** How long one send may take before it is aborted: Resend's, and a module transport's unless EMAIL_TRANSPORT_TIMEOUT_MS says otherwise. */
export const EMAIL_TRANSPORT_TIMEOUT_DEFAULT_MS = 10_000;
const TIMEOUT_MIN_MS = 1_000;
const TIMEOUT_MAX_MS = 120_000;

/** `module`: a transport a platform module contributes (its id is `emailTransportId`). */
export type EmailTransportKind = 'smtp' | 'resend' | 'module';

const KINDS: readonly string[] = BUILTIN_EMAIL_TRANSPORTS;

/** EMAIL_TRANSPORT trimmed and lower-cased (`smtp` when unset). */
export function emailTransportId(env: NodeJS.ProcessEnv = process.env): string {
  return env.EMAIL_TRANSPORT?.trim().toLowerCase() || 'smtp';
}

/** The configured transport; an invalid value is a config error (see `emailConfigError`), read here as smtp. */
export function emailTransportKind(env: NodeJS.ProcessEnv = process.env): EmailTransportKind {
  const raw = emailTransportId(env);
  if (KINDS.includes(raw)) return raw as EmailTransportKind;
  return EMAIL_TRANSPORT_ID_RE.test(raw) ? 'module' : 'smtp';
}

/** EMAIL_TRANSPORT_TIMEOUT_MS (a module transport's cut-off), or null when it is set but not an integer in range. */
export function emailTransportTimeoutMs(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.EMAIL_TRANSPORT_TIMEOUT_MS?.trim();
  if (!raw) return EMAIL_TRANSPORT_TIMEOUT_DEFAULT_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= TIMEOUT_MIN_MS && n <= TIMEOUT_MAX_MS ? n : null;
}

export function emailTransportTimeoutError(env: NodeJS.ProcessEnv = process.env): string | null {
  return emailTransportTimeoutMs(env) === null
    ? `EMAIL_TRANSPORT_TIMEOUT_MS must be milliseconds between ${TIMEOUT_MIN_MS} and ${TIMEOUT_MAX_MS} (default ${EMAIL_TRANSPORT_TIMEOUT_DEFAULT_MS}).`
    : null;
}

/** RESEND_API_KEY trimmed ('' when unset). Never log or echo the value. */
export function resendApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.RESEND_API_KEY?.trim() ?? '';
}

/**
 * A start-up refusal for the e-mail settings, or null when they are usable:
 * an EMAIL_TRANSPORT that is neither built in nor a transport id, `resend`
 * without RESEND_API_KEY, `smtp` without SMTP_HOST in production (sign-in
 * codes could not go out; outside production the code is logged instead) or
 * an invalid EMAIL_TRANSPORT_TIMEOUT_MS. A module transport is checked when
 * the modules load. Names variables only — never a value.
 */
export function emailConfigError(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = emailTransportId(env);
  if (!KINDS.includes(raw) && !EMAIL_TRANSPORT_ID_RE.test(raw)) {
    return 'EMAIL_TRANSPORT must be "smtp" (default), "resend" or the id of a module e-mail transport (2–16 lowercase letters and digits).';
  }
  if (raw === 'resend' && !resendApiKey(env)) {
    return 'EMAIL_TRANSPORT=resend needs RESEND_API_KEY (the Resend API key, a secret): set it in the server env or switch back to EMAIL_TRANSPORT=smtp.';
  }
  if (raw === 'smtp' && env.NODE_ENV === 'production' && !env.SMTP_HOST?.trim()) {
    return 'SMTP_HOST must be set in production (your SMTP server), or use EMAIL_TRANSPORT=resend with RESEND_API_KEY.';
  }
  return emailTransportTimeoutError(env);
}
