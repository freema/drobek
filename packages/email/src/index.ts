/**
 * @drobek/email — the operator's outgoing e-mail, shared by everything that
 * sends: the dashboard login codes and workspace invites (@drobek/auth,
 * @drobek/tenancy) and the platform modules' `ctx.email.send`
 * (@drobek/modules — the global hourly cap, recipients and audit live there;
 * per-app policy in the `email` module).
 *
 * One transport for all of it, chosen by EMAIL_TRANSPORT: `smtp` (default —
 * generic SMTP through nodemailer: SMTP_HOST, SMTP_PORT, SMTP_SECURE,
 * SMTP_USER, SMTP_PASS) or `resend` (the Resend HTTP API over fetch, no
 * vendor SDK: RESEND_API_KEY). EMAIL_FROM is the sender for both.
 */
export { smtpConfigured, getSmtpTransport, getEmailFrom, resetSmtpTransportForTests } from './smtp.server.js';
export { renderEmailLayout, escapeHtml, emailBrand, type EmailLayoutInput } from './layout.server.js';
export { MASCOT_COLORS, MASCOT_HEIGHT, MASCOT_RECTS, MASCOT_WIDTH, mascotDataUri, mascotEmailHtml, mascotSvg, type MascotRect } from './mascot.js';
export { renderTextEmailHtml, type TextEmailInput } from './text-email.js';
export { emailFromParts, fromHeader, safeDisplayName, sendEmail, type OutgoingEmail } from './send.server.js';
export { emailConfigError, emailTransportKind, type EmailTransportKind } from './transport.server.js';
export { EmailSendError, RESEND_API_URL, RESEND_TIMEOUT_MS, type EmailSendErrorCode } from './resend.server.js';
