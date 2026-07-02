/**
 * Generic SMTP transport (nodemailer) — no vendor SDKs. Prod is Hostinger
 * SMTP (operator provides creds at deploy); local dev is mailpit (no auth).
 * Env: SMTP_HOST, SMTP_PORT, SMTP_SECURE (0/1), SMTP_USER, SMTP_PASS,
 * EMAIL_FROM.
 */
import type { Transporter } from 'nodemailer';

let cached: Transporter | null = null;

export function smtpConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  // mailpit needs no auth — host alone counts as configured.
  return Boolean(env.SMTP_HOST?.trim());
}

async function buildTransport(env: NodeJS.ProcessEnv): Promise<Transporter> {
  const nodemailer = (await import('nodemailer')).default;
  const host = env.SMTP_HOST?.trim();

  if (!host) {
    if (env.NODE_ENV === 'production') {
      throw new Error('SMTP_HOST must be set in production');
    }
    // Dev fallback: serialize mails to JSON instead of sending.
    return nodemailer.createTransport({ jsonTransport: true });
  }

  const port = Number(env.SMTP_PORT ?? 587);
  const secure = String(env.SMTP_SECURE ?? '0') === '1';
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS?.trim();

  return nodemailer.createTransport({
    host,
    port,
    secure,
    ...(user && pass ? { auth: { user, pass } } : {}),
  });
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
