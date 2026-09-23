/**
 * Send one message through the operator's SMTP (EMAIL_FROM is always the
 * sender address — SPF/DKIM belong to the operator's domain). A caller may
 * set a display NAME for the sender and a Reply-To; both are passed to
 * nodemailer as structured address objects, never as header text, and the
 * name is reduced to one plain line first — so nothing a caller passes can
 * inject a header.
 *
 * Without SMTP_HOST outside production nothing is sent (the caller logs it);
 * in production a missing SMTP config is an error.
 */
import { getEmailFrom, getSmtpTransport, smtpConfigured } from './smtp.server.js';

export interface OutgoingEmail {
  /** One address (one message per recipient: recipients never see each other). */
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Display name of the sender (the address stays EMAIL_FROM's). */
  fromName?: string;
  replyTo?: string;
}

const ANGLE_ADDR = /<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/;
const MAX_NAME = 80;

/** EMAIL_FROM → `{ name, address }` (`drobek <no-reply@drobek.app>` or a bare address). */
export function emailFromParts(env: NodeJS.ProcessEnv = process.env): { name: string; address: string } {
  const raw = getEmailFrom(env);
  const m = ANGLE_ADDR.exec(raw);
  if (!m) return { name: '', address: raw.trim() };
  const name = raw.slice(0, m.index).trim().replace(/^"(.*)"$/, '$1');
  return { name, address: m[1] };
}

/** A display name that is one plain line: no control characters, no quotes/angle brackets/@, capped. */
export function safeDisplayName(name: string | undefined): string {
  return String(name ?? '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029"<>@\\]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
}

/** The nodemailer `from` for a message: EMAIL_FROM's address, optionally under another display name. */
export function fromHeader(fromName: string | undefined, env: NodeJS.ProcessEnv = process.env): { name: string; address: string } {
  const base = emailFromParts(env);
  const name = safeDisplayName(fromName);
  return { name: name || base.name, address: base.address };
}

/** Deliver `mail`; 'not_configured' when SMTP is not set up in dev (nothing was sent). */
export async function sendEmail(mail: OutgoingEmail, env: NodeJS.ProcessEnv = process.env): Promise<'sent' | 'not_configured'> {
  if (!smtpConfigured(env)) {
    if (env.NODE_ENV === 'production') throw new Error('SMTP is not configured (set SMTP_HOST)');
    return 'not_configured';
  }
  const transport = await getSmtpTransport(env);
  await transport.sendMail({
    from: fromHeader(mail.fromName, env),
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
  });
  return 'sent';
}
