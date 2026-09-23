/**
 * @drobek/email — the operator's outgoing e-mail, shared by everything that
 * sends: the dashboard login codes and workspace invites (@drobek/auth,
 * @drobek/tenancy) and the platform modules' `ctx.email.send`
 * (@drobek/modules — the global hourly cap, recipients and audit live there;
 * per-app policy in the `email` module).
 *
 * Generic SMTP through nodemailer (no vendor SDKs): SMTP_HOST, SMTP_PORT,
 * SMTP_SECURE, SMTP_USER, SMTP_PASS, EMAIL_FROM.
 */
export { smtpConfigured, getSmtpTransport, getEmailFrom, resetSmtpTransportForTests } from './smtp.server.js';
export { renderEmailLayout, escapeHtml, emailBrand, type EmailLayoutInput } from './layout.server.js';
export { renderTextEmailHtml, type TextEmailInput } from './text-email.js';
export { emailFromParts, fromHeader, safeDisplayName, sendEmail, type OutgoingEmail } from './send.server.js';
