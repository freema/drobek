import { logger } from '../logger.server.js';
import { maskEmail } from '../mask-email.js';
import {
  getEmailFrom,
  getSmtpTransport,
  smtpConfigured,
} from './smtp.server.js';
import { renderLoginCodeEmail } from './templates/login-code.server.js';

/** Deliver the e-mail login code via SMTP (dev fallback: log the code). */
export async function sendLoginCodeEmail(args: {
  email: string;
  code: string;
}): Promise<void> {
  const { subject, html, text } = renderLoginCodeEmail({ code: args.code });

  if (smtpConfigured()) {
    const t = await getSmtpTransport();
    await t.sendMail({
      from: getEmailFrom(),
      to: args.email,
      subject,
      text,
      html,
    });
    // Full addresses never hit the logs — masked only (spec §5).
    logger.info('[mail] login code sent', { email: maskEmail(args.email) });
    return;
  }

  if (process.env.NODE_ENV !== 'production') {
    logger.info('[mail] SMTP not configured — dev fallback, logging code', {
      email: maskEmail(args.email),
      code: args.code,
    });
    return;
  }

  throw new Error('Configure SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS for production');
}
