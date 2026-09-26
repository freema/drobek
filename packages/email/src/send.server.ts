/**
 * Send one message through the operator's transport — SMTP (nodemailer) or
 * Resend (HTTP API), chosen by EMAIL_TRANSPORT (transport.server.ts).
 * EMAIL_FROM is always the sender address (SPF/DKIM belong to the operator's
 * domain; with Resend it must be on a domain verified there). A caller may
 * set a display NAME for the sender and a Reply-To; both are passed as
 * structured values, never as header text, and the name is reduced to one
 * plain line first — so nothing a caller passes can inject a header.
 *
 * SMTP without SMTP_HOST outside production sends nothing (the caller logs
 * it); in production a missing SMTP config is an error. Resend without
 * RESEND_API_KEY is always an error (the server refuses to start that way).
 */
import type { SendMailOptions } from 'nodemailer';
import { sendViaResend } from './resend.server.js';
import { getEmailFrom, getSmtpTransport, smtpConfigured } from './smtp.server.js';
import { emailTransportKind } from './transport.server.js';

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

/** The nodemailer message for `mail`: sender and Reply-To as address objects, never header text. */
export function messageFor(mail: OutgoingEmail, env: NodeJS.ProcessEnv = process.env): SendMailOptions {
  return {
    from: fromHeader(mail.fromName, env),
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
  };
}

/** Deliver `mail`; 'not_configured' when SMTP is not set up in dev (nothing was sent). */
export async function sendEmail(mail: OutgoingEmail, env: NodeJS.ProcessEnv = process.env): Promise<'sent' | 'not_configured'> {
  if (emailTransportKind(env) === 'resend') {
    await sendViaResend(mail, fromHeader(mail.fromName, env), env);
    return 'sent';
  }
  if (!smtpConfigured(env)) {
    if (env.NODE_ENV === 'production') throw new Error('SMTP is not configured (set SMTP_HOST)');
    return 'not_configured';
  }
  const transport = await getSmtpTransport(env);
  await transport.sendMail(messageFor(mail, env));
  return 'sent';
}
