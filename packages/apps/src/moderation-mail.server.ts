/**
 * The owners' moderation e-mail: a takedown or a restore tells the app's
 * owners (its workspace's editors and workspace-admins) the reason CATEGORY
 * and what happens next — never a reporter's text or address. Platform mail
 * in the drobek layout. The dashboard's moderation queue and the MCP tools
 * takedown_app / restore_app send it after the change committed; every
 * failure is logged and swallowed — the takedown already happened and must
 * not fail because the mailbox is down.
 */
import type { Logger } from '@drobek/core';
import { dbErrorForLog } from '@drobek/db';
import { renderPlatformEmail, sendEmail, serverFootNote } from '@drobek/email';
import { reasonLabel, termsUrl } from './moderation.js';
import { workspacePublisherEmails } from './publish-approval.server.js';

/** Deliver one mail; false = not sent (no transport configured in dev). */
type Mailer = (mail: { to: string; subject: string; text: string; html: string }) => Promise<boolean>;

const defaultMailer = (env: NodeJS.ProcessEnv): Mailer => async (mail) => (await sendEmail(mail, env)) === 'sent';

/** Tell the app's owners it was taken down (category only) or restored; the number of e-mails sent. Never throws. */
export async function mailOwnersAboutModeration(
  input: { kind: 'takedown' | 'restore'; app: { slug: string; workspaceId: string }; reason: string },
  log: Logger,
  env: NodeJS.ProcessEnv = process.env,
  send: Mailer = defaultMailer(env)
): Promise<number> {
  const meta = { app: input.app.slug, kind: input.kind };
  try {
    const to = await workspacePublisherEmails(input.app.workspaceId);
    if (to.length === 0) return 0;
    const terms = termsUrl(env);
    const subject =
      input.kind === 'takedown'
        ? `Your app ${input.app.slug} was taken down`
        : `Your app ${input.app.slug} was restored`;
    const text =
      input.kind === 'takedown'
        ? [
            `The operator of this drobek server took your app ${input.app.slug} down.`,
            '',
            `Reason: ${reasonLabel(input.reason)}.`,
            '',
            'The app is unpublished and every one of its addresses shows an "unavailable" page. It cannot be changed, published or reconfigured — neither in the dashboard nor by your coding agent — until the operator restores it.',
            '',
            `Terms of service: ${terms}`,
            'If you think this is a mistake, reply to the operator of this server.',
          ].join('\n')
        : [
            `The operator of this drobek server restored your app ${input.app.slug}.`,
            '',
            'You can change it again. It is NOT published: publish a version from the dashboard or ask your agent to publish when it is ready.',
            '',
            `Terms of service: ${terms}`,
          ].join('\n');
    const rendered = renderPlatformEmail({ subject, text, footNote: serverFootNote('you can edit this app', env) }, env);
    let sent = 0;
    for (const address of to) {
      try {
        if (await send({ to: address, subject, ...rendered })) sent++;
        else log.info('abuse e-mail not sent (SMTP not configured in dev)', { ...meta, subject });
      } catch (err) {
        log.error('abuse e-mail failed', { ...meta, error: dbErrorForLog(err) });
      }
    }
    return sent;
  } catch (err) {
    log.error('abuse e-mail failed', { ...meta, error: dbErrorForLog(err) });
    return 0;
  }
}
