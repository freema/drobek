/**
 * The three e-mails of a sign-in e-mail change, in the sign-in code's layout
 * and through the operator's transport (SMTP or Resend; without SMTP outside
 * production the code is logged):
 *
 *  - the code, to the NEW address;
 *  - "this address already has an account", to a new address another account
 *    signs in with (instead of a code, so the page answers the same either
 *    way and only the owner of that mailbox learns the account exists);
 *  - the notice to the PREVIOUS address once the change is made.
 *
 * Addresses are masked in logs.
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

interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const heading = (text: string) =>
  `<h1 style="margin:0 0 8px;font-size:20px;line-height:1.3;font-weight:600;color:${emailBrand.ink};">${escapeHtml(text)}</h1>`;
const para = (text: string) => `<p style="margin:0 0 24px;color:${emailBrand.muted};">${escapeHtml(text)}</p>`;
const small = (text: string) => `<p style="margin:0;font-size:13px;color:${emailBrand.faint};">${escapeHtml(text)}</p>`;

export function renderEmailChangeCodeEmail(vars: { code: string }, env: NodeJS.ProcessEnv = process.env): RenderedEmail {
  const code = vars.code.trim();
  const host = serverHost(env);
  const intro = `Enter this code on your Account page at ${host}. It works once, for 10 minutes. From then on you sign in to drobek with this address.`;
  const ignore = "Didn't ask for it? Ignore this e-mail: nothing changes without the code.";
  const body = `
    ${heading('Confirm your new sign-in e-mail')}
    ${para(intro)}
    <p style="margin:0 0 24px;font-family:'SF Mono',Menlo,Consolas,'Liberation Mono',monospace;font-size:32px;line-height:1.2;font-weight:600;letter-spacing:0.25em;color:${emailBrand.ink};">${escapeHtml(code)}</p>
    ${small(ignore)}
  `;
  return {
    subject: `drobek — your code to confirm your new sign-in e-mail: ${code}`,
    html: renderEmailLayout({
      preview: `Your code to confirm your new sign-in e-mail: ${code}`,
      body,
      footNote: escapeHtml(serverFootNote('someone signed in to drobek asked to sign in with this address from now on', env)),
    }),
    text: [`Your code to confirm your new drobek sign-in e-mail: ${code}`, '', intro, '', ignore].join('\n'),
  };
}

export function renderEmailInUseEmail(env: NodeJS.ProcessEnv = process.env): RenderedEmail {
  const host = serverHost(env);
  const intro = `Someone signed in at ${host} asked to make this address the sign-in e-mail of their drobek account. This address already signs in to a drobek account, so nothing changed and no code was sent.`;
  const ifYou =
    'If it was you: sign in with this address to use that account. To move this address to the other account, delete the account that uses it (Account → Delete account) and ask for the change again.';
  const ignore = "Didn't ask for it? Ignore this e-mail.";
  const body = `
    ${heading('This address already has a drobek account')}
    ${para(intro)}
    ${para(ifYou)}
    ${small(ignore)}
  `;
  return {
    subject: 'drobek — this address already has an account',
    html: renderEmailLayout({
      preview: 'This address already has a drobek account; nothing changed.',
      body,
      footNote: escapeHtml(serverFootNote('someone signed in to drobek asked to sign in with this address', env)),
    }),
    text: [intro, '', ifYou, '', ignore].join('\n'),
  };
}

export function renderEmailChangedEmail(
  vars: { maskedNewEmail: string; contact: string | null },
  env: NodeJS.ProcessEnv = process.env
): RenderedEmail {
  const host = serverHost(env);
  const intro = `The drobek account at ${host} that signed in with this address now signs in with ${vars.maskedNewEmail}. Every other session of the account was signed out; its API keys and agent connections keep working.`;
  const after = 'This address no longer signs in to that account: signing in with it starts a new, empty account.';
  const notYou = vars.contact
    ? `Didn't change it? Someone signed in as you did. Write to the operator of this server at ${vars.contact}.`
    : `Didn't change it? Someone signed in as you did. Contact the operator of ${host}.`;
  const body = `
    ${heading('Your sign-in e-mail was changed')}
    ${para(intro)}
    ${para(after)}
    ${small(notYou)}
  `;
  return {
    subject: 'drobek — your sign-in e-mail was changed',
    html: renderEmailLayout({
      preview: `Your drobek account now signs in with ${vars.maskedNewEmail}.`,
      body,
      footNote: escapeHtml(serverFootNote('the drobek account of this address changed its sign-in e-mail', env)),
    }),
    text: [intro, '', after, '', notYou].join('\n'),
  };
}

async function deliver(to: string, mail: RenderedEmail, what: string, devLog: Record<string, unknown> = {}): Promise<void> {
  const r = await sendEmail({ to, subject: mail.subject, text: mail.text, html: mail.html });
  if (r === 'sent') {
    logger.info(`[mail] ${what} sent`, { email: maskEmail(to) });
    return;
  }
  logger.info(`[mail] SMTP not configured — dev fallback, ${what} not sent`, { email: maskEmail(to), ...devLog });
}

/** The code to the new address (dev fallback without SMTP: log the code). */
export async function sendEmailChangeCodeEmail(args: { email: string; code: string }): Promise<void> {
  await deliver(args.email, renderEmailChangeCodeEmail({ code: args.code }), 'sign-in e-mail change code', { code: args.code });
}

/** The "already has an account" e-mail to a new address another account uses. */
export async function sendEmailInUseEmail(args: { email: string }): Promise<void> {
  await deliver(args.email, renderEmailInUseEmail(), 'sign-in e-mail change: address in use');
}

/** The notice to the previous address after the change. */
export async function sendEmailChangedEmail(args: { email: string; newEmail: string; contact: string | null }): Promise<void> {
  const mail = renderEmailChangedEmail({ maskedNewEmail: maskEmail(args.newEmail), contact: args.contact });
  await deliver(args.email, mail, 'sign-in e-mail change notice');
}
