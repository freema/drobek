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
 * vendor SDK: RESEND_API_KEY), or the id of a transport a platform module
 * contributes to the `email.transport` slot (module-transport.server.ts).
 * EMAIL_FROM is the sender for all of them.
 */
export { smtpConfigured, getSmtpTransport, getEmailFrom, resetSmtpTransportForTests } from './smtp.server.js';
export { renderEmailLayout, escapeHtml, emailBrand, emailFont, type EmailLayoutInput } from './layout.server.js';
export {
  platformEmailText,
  renderEmailActionsHtml,
  renderPlatformEmail,
  serverFootNote,
  serverHost,
  serverOrigin,
  trustedActionUrl,
  type EmailAction,
  type PlatformEmailInput,
} from './platform-email.js';
export { MASCOT_COLORS, MASCOT_HEIGHT, MASCOT_RECTS, MASCOT_WIDTH, mascotDataUri, mascotEmailHtml, mascotSvg, type MascotRect } from './mascot.js';
export { renderTextEmailHtml, type TextEmailInput } from './text-email.js';
export { emailFromParts, fromHeader, safeDisplayName, sendEmail, type OutgoingEmail } from './send.server.js';
export {
  BUILTIN_EMAIL_TRANSPORTS,
  EMAIL_TRANSPORT_ID_RE,
  emailConfigError,
  emailTransportId,
  emailTransportKind,
  type EmailTransportKind,
} from './transport.server.js';
export { EMAIL_SEND_ERROR_CODES, EmailSendError, RESEND_API_URL, RESEND_TIMEOUT_MS, type EmailSendErrorCode, type Sender } from './resend.server.js';
export {
  EMAIL_TRANSPORT_API_VERSION,
  installEmailTransport,
  installedEmailTransportId,
  missingTransportSecrets,
  resetEmailTransportForTests,
  type EmailTransportContext,
  type EmailTransportMessage,
  type ModuleEmailTransport,
} from './module-transport.server.js';
