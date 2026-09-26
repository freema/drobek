import { logger } from '../logger.server.js';
import { maskEmail } from '../mask-email.js';
import { sendEmail } from '@drobek/email';
import { renderLoginCodeEmail } from './templates/login-code.server.js';

/** Deliver the e-mail login code through the operator's transport (SMTP or Resend; dev fallback without SMTP: log the code). */
export async function sendLoginCodeEmail(args: {
  email: string;
  code: string;
}): Promise<void> {
  const { subject, html, text } = renderLoginCodeEmail({ code: args.code });

  // 'not_configured' only happens outside production (SMTP without SMTP_HOST);
  // production without a transport throws inside sendEmail.
  const r = await sendEmail({ to: args.email, subject, text, html });
  if (r === 'sent') {
    // Full addresses never hit the logs — masked only (spec §5).
    logger.info('[mail] login code sent', { email: maskEmail(args.email) });
    return;
  }
  logger.info('[mail] SMTP not configured — dev fallback, logging code', {
    email: maskEmail(args.email),
    code: args.code,
  });
}
