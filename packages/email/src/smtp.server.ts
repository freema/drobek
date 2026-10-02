/**
 * Generic SMTP transport (nodemailer) — no vendor SDKs. Prod is Hostinger
 * SMTP (operator provides creds at deploy); local dev is mailpit (no auth).
 * Env: SMTP_HOST, SMTP_PORT, SMTP_SECURE (0/1), SMTP_USER, SMTP_PASS,
 * EMAIL_FROM, and the three timeouts below.
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
 * How long a send waits on the SMTP server: to connect, for its greeting, and
 * on a silent socket. nodemailer's own defaults (2 min, 30 s, 10 min) would
 * hold a sign-in request that long when the server hangs; these fail it fast
 * so the user can retry.
 */
const SMTP_TIMEOUTS = {
  connectionTimeout: { env: 'SMTP_CONNECTION_TIMEOUT_MS', defaultMs: 10_000 },
  greetingTimeout: { env: 'SMTP_GREETING_TIMEOUT_MS', defaultMs: 10_000 },
  socketTimeout: { env: 'SMTP_SOCKET_TIMEOUT_MS', defaultMs: 30_000 },
} as const;
type SmtpTimeout = keyof typeof SMTP_TIMEOUTS;
const SMTP_TIMEOUT_KEYS = Object.keys(SMTP_TIMEOUTS) as SmtpTimeout[];
const SMTP_TIMEOUT_MIN_MS = 1_000;
const SMTP_TIMEOUT_MAX_MS = 120_000;

/** One SMTP timeout from the env: its default when unset, null when set but not an integer in range. */
function smtpTimeoutMs(env: NodeJS.ProcessEnv, key: SmtpTimeout): number | null {
  const { env: name, defaultMs } = SMTP_TIMEOUTS[key];
  const raw = env[name]?.trim();
  if (!raw) return defaultMs;
  const n = Number(raw);
  return Number.isInteger(n) && n >= SMTP_TIMEOUT_MIN_MS && n <= SMTP_TIMEOUT_MAX_MS ? n : null;
}

/** A start-up refusal naming every SMTP timeout set to an invalid value, or null. */
export function smtpTimeoutError(env: NodeJS.ProcessEnv = process.env): string | null {
  const bad = SMTP_TIMEOUT_KEYS.filter((key) => smtpTimeoutMs(env, key) === null).map((key) => SMTP_TIMEOUTS[key].env);
  if (bad.length === 0) return null;
  const defaults = SMTP_TIMEOUT_KEYS.map((key) => `${SMTP_TIMEOUTS[key].env} ${SMTP_TIMEOUTS[key].defaultMs}`).join(', ');
  return `${bad.join(', ')} must be milliseconds between ${SMTP_TIMEOUT_MIN_MS} and ${SMTP_TIMEOUT_MAX_MS} (defaults: ${defaults}).`;
}

/**
 * The SMTP transport options from the env. SMTP_SECURE=1 is implicit TLS
 * (port 465); otherwise the connection starts plain and nodemailer upgrades
 * it with STARTTLS when the server offers it (port 587, Hostinger's default).
 * No auth when SMTP_USER / SMTP_PASS are unset (mailpit). An invalid timeout
 * (refused at start, see `smtpTimeoutError`) falls back to its default.
 */
export function smtpTransportOptions(env: NodeJS.ProcessEnv): SMTPTransportOptions {
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS?.trim();
  const timeout = (key: SmtpTimeout) => smtpTimeoutMs(env, key) ?? SMTP_TIMEOUTS[key].defaultMs;
  return {
    host: env.SMTP_HOST?.trim(),
    port: Number(env.SMTP_PORT ?? 587),
    secure: String(env.SMTP_SECURE ?? '0') === '1',
    ...(user && pass ? { auth: { user, pass } } : {}),
    connectionTimeout: timeout('connectionTimeout'),
    greetingTimeout: timeout('greetingTimeout'),
    socketTimeout: timeout('socketTimeout'),
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
