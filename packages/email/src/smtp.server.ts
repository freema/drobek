/**
 * Generic SMTP transport (nodemailer) — no vendor SDKs. Prod is Hostinger
 * SMTP (operator provides creds at deploy); local dev is mailpit (no auth).
 * Env: SMTP_HOST, SMTP_PORT, SMTP_SECURE (0/1), SMTP_USER, SMTP_PASS,
 * EMAIL_FROM.
 */
import type { SMTPTransportOptions, Transporter } from 'nodemailer';

let cached: Transporter | null = null;

export function smtpConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  // mailpit needs no auth — host alone counts as configured.
  return Boolean(env.SMTP_HOST?.trim());
}

/**
 * The SMTP transport options from the env. SMTP_SECURE=1 is implicit TLS
 * (port 465); otherwise the connection starts plain and nodemailer upgrades
 * it with STARTTLS when the server offers it (port 587, Hostinger's default).
 * No auth when SMTP_USER / SMTP_PASS are unset (mailpit).
 */
export function smtpTransportOptions(env: NodeJS.ProcessEnv): SMTPTransportOptions {
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS?.trim();
  return {
    host: env.SMTP_HOST?.trim(),
    port: Number(env.SMTP_PORT ?? 587),
    secure: String(env.SMTP_SECURE ?? '0') === '1',
    ...(user && pass ? { auth: { user, pass } } : {}),
  };
}

async function buildTransport(env: NodeJS.ProcessEnv): Promise<Transporter> {
  const nodemailer = (await import('nodemailer')).default;

  if (!env.SMTP_HOST?.trim()) {
    if (env.NODE_ENV === 'production') {
      throw new Error('SMTP_HOST must be set in production');
    }
    // Dev fallback: serialize mails to JSON instead of sending.
    return nodemailer.createTransport({ jsonTransport: true });
  }

  return nodemailer.createTransport(smtpTransportOptions(env));
}

/** Lazy-load nodemailer so Vite SSR route graphs never eagerly bundle it. */
export async function getSmtpTransport(
  env: NodeJS.ProcessEnv = process.env
): Promise<Transporter> {
  if (!cached) cached = await buildTransport(env);
  return cached;
}

export function getEmailFrom(env: NodeJS.ProcessEnv = process.env): string {
  return env.EMAIL_FROM?.trim() || 'drobek <no-reply@drobek.app>';
}

/** @internal test helper */
export function resetSmtpTransportForTests(): void {
  cached = null;
}
