/**
 * Which transport carries the operator's outgoing mail — one switch for the
 * dashboard (sign-in codes, invites, abuse notices) and the platform modules'
 * `ctx.email.send`: `EMAIL_TRANSPORT=smtp` (default, nodemailer) or `resend`
 * (the Resend HTTP API over `fetch`, needs `RESEND_API_KEY`). The rate limits
 * (OTP_*, EMAIL_GLOBAL_* …) live above this layer and apply to both.
 */

export type EmailTransportKind = 'smtp' | 'resend';

const KINDS: readonly string[] = ['smtp', 'resend'];

function rawKind(env: NodeJS.ProcessEnv): string {
  return env.EMAIL_TRANSPORT?.trim().toLowerCase() || 'smtp';
}

/** The configured transport; an unknown value is a config error (see `emailConfigError`), read here as smtp. */
export function emailTransportKind(env: NodeJS.ProcessEnv = process.env): EmailTransportKind {
  const raw = rawKind(env);
  return KINDS.includes(raw) ? (raw as EmailTransportKind) : 'smtp';
}

/** RESEND_API_KEY trimmed ('' when unset). Never log or echo the value. */
export function resendApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.RESEND_API_KEY?.trim() ?? '';
}

/**
 * A start-up refusal for the e-mail settings, or null when they are usable:
 * an unknown EMAIL_TRANSPORT, `resend` without RESEND_API_KEY, or `smtp`
 * without SMTP_HOST in production (sign-in codes could not go out; outside
 * production the code is logged instead). Names variables only — never a value.
 */
export function emailConfigError(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = rawKind(env);
  if (!KINDS.includes(raw)) return 'EMAIL_TRANSPORT must be "smtp" (default) or "resend".';
  if (raw === 'resend' && !resendApiKey(env)) {
    return 'EMAIL_TRANSPORT=resend needs RESEND_API_KEY (the Resend API key, a secret): set it in the server env or switch back to EMAIL_TRANSPORT=smtp.';
  }
  if (raw === 'smtp' && env.NODE_ENV === 'production' && !env.SMTP_HOST?.trim()) {
    return 'SMTP_HOST must be set in production (your SMTP server), or use EMAIL_TRANSPORT=resend with RESEND_API_KEY.';
  }
  return null;
}
