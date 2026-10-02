/**
 * The e-mail with the code that confirms an account deletion — the same
 * layout and operator transport as the sign-in code (SMTP or Resend; without
 * SMTP outside production the code is logged). Addresses are masked in logs.
 */
import {
  emailBrand,
  escapeHtml,
  logger,
  maskEmail,
  renderEmailLayout,
  sendEmail,
  serverFootNote,
  serverHost,
} from '@drobek/auth';

interface RenderedAccountDeleteCodeEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderAccountDeleteCodeEmail(
  vars: { code: string },
  env: NodeJS.ProcessEnv = process.env
): RenderedAccountDeleteCodeEmail {
  const code = vars.code.trim();
  const host = serverHost(env);
  const subject = `drobek — your code to delete your account: ${code}`;

  const body = `
    <h1 style="margin:0 0 8px;font-size:20px;line-height:1.3;font-weight:600;color:${emailBrand.ink};">Confirm deleting your account</h1>
    <p style="margin:0 0 24px;color:${emailBrand.muted};">Enter this code on the Delete account page at ${escapeHtml(host)}. It works once, for 10 minutes. Your account, your personal workspace and its apps are then deleted for good.</p>
    <p style="margin:0 0 24px;font-family:'SF Mono',Menlo,Consolas,'Liberation Mono',monospace;font-size:32px;line-height:1.2;font-weight:600;letter-spacing:0.25em;color:${emailBrand.ink};">${escapeHtml(code)}</p>
    <p style="margin:0;font-size:13px;color:${emailBrand.faint};">Didn&#39;t ask for it? Nothing is deleted without the code. Someone signed in as you asked for it: check your connected agents and API keys.</p>
  `;

  const html = renderEmailLayout({
    preview: `Your code to delete your account: ${code}`,
    body,
    footNote: escapeHtml(serverFootNote('someone signed in with this address asked to delete the account', env)),
  });

  const text = [
    `Your code to delete your drobek account: ${code}`,
    '',
    `Enter it on the Delete account page at ${host}. It works once, for 10 minutes. Your account, your personal workspace and its apps are then deleted for good.`,
    '',
    "Didn't ask for it? Nothing is deleted without the code. Someone signed in as you asked for it: check your connected agents and API keys.",
  ].join('\n');

  return { subject, html, text };
}

/** Deliver the deletion code through the operator's transport (dev fallback without SMTP: log the code). */
export async function sendAccountDeleteCodeEmail(args: { email: string; code: string }): Promise<void> {
  const { subject, html, text } = renderAccountDeleteCodeEmail({ code: args.code });
  const r = await sendEmail({ to: args.email, subject, text, html });
  if (r === 'sent') {
    logger.info('[mail] account deletion code sent', { email: maskEmail(args.email) });
    return;
  }
  logger.info('[mail] SMTP not configured — dev fallback, logging the account deletion code', {
    email: maskEmail(args.email),
    code: args.code,
  });
}
