/**
 * The moderation e-mails (M4-02, NSO-293), plain text in the drobek layout
 * (renderTextEmailHtml escapes everything, so a reporter's text can never
 * become markup in the operator's mail client):
 *
 *  - a new report → every super-admin (SUPERADMIN_EMAIL), at most ONE mail
 *    per reported app (or unresolved host) per hour — a flood of reports on
 *    one app does not flood the operator (`drobek:abuse:mail:<key>`, Redis
 *    SET NX, 1 h; a Redis error sends anyway);
 *  - a takedown / a restore → the app's owners (its workspace's editors and
 *    workspace-admins): the reason CATEGORY and what happens next — never the
 *    reporter's text or address.
 *
 * Delivery errors are logged and swallowed: the report / the takedown already
 * happened and must not fail because the mailbox is down.
 */
import { ABUSE_QUEUE_PATH, dashboardOrigin, reasonLabel, termsUrl, type ReportedApp } from '@drobek/apps';
import { superAdminEmails } from '@drobek/auth';
import { getRedis, type Logger } from '@drobek/core';
import { getDb } from '@drobek/db';
import { renderTextEmailHtml, sendEmail } from '@drobek/email';
import { appOwnerEmails } from '@drobek/modules';

export const REPORT_MAIL_DEDUP_MS = 60 * 60 * 1000;

export function reportMailDedupKey(key: string): string {
  return `drobek:abuse:mail:${key}`;
}

async function firstInWindow(key: string, log: Logger): Promise<boolean> {
  try {
    const ok = await getRedis().set(reportMailDedupKey(key), '1', 'PX', REPORT_MAIL_DEDUP_MS, 'NX');
    return ok === 'OK';
  } catch (err) {
    log.warn('abuse report mail dedup unavailable — sending', { error: String((err as Error)?.message ?? err) });
    return true;
  }
}

async function deliver(to: string[], subject: string, text: string, log: Logger, meta: Record<string, unknown>): Promise<number> {
  let sent = 0;
  for (const address of to) {
    try {
      const r = await sendEmail({ to: address, subject, text, html: renderTextEmailHtml({ subject, text }) });
      if (r === 'sent') sent++;
      else log.info('abuse e-mail not sent (SMTP not configured in dev)', { ...meta, subject });
    } catch (err) {
      log.error('abuse e-mail failed', { ...meta, error: String((err as Error)?.message ?? err) });
    }
  }
  return sent;
}

export interface ReportMailInput {
  reportId: string;
  host: string;
  reason: string;
  details: string;
  reporterEmail: string | null;
  app: ReportedApp | null;
}

/** Tell the super-admins about a new report (deduped per app / host per hour). */
export async function mailSuperAdminsAboutReport(
  input: ReportMailInput,
  log: Logger,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ sent: number; deduped: boolean }> {
  const to = superAdminEmails(env.SUPERADMIN_EMAIL);
  if (to.length === 0) {
    log.warn('abuse report stored but SUPERADMIN_EMAIL is empty — nobody is notified', { report_id: input.reportId });
    return { sent: 0, deduped: false };
  }
  if (!(await firstInWindow(input.app?.id ?? `host:${input.host}`, log))) {
    log.info('abuse report mail deduped (one per app per hour)', { report_id: input.reportId, app_id: input.app?.id ?? null });
    return { sent: 0, deduped: true };
  }
  const subject = `Abuse report: ${input.host} (${input.reason})`;
  const lines = [
    `A new abuse report was filed for ${input.host}.`,
    '',
    `Reason: ${reasonLabel(input.reason)} (${input.reason})`,
    input.app
      ? `App: ${input.app.slug} in workspace ${input.app.workspaceSlug}${input.app.lockedReason ? ` — already taken down (${input.app.lockedReason})` : ''}`
      : 'App: no app on this server matches the host.',
    `Reporter: ${input.reporterEmail ?? 'anonymous'}`,
    '',
    'Details:',
    input.details || '(none)',
    '',
    `Review the queue: ${dashboardOrigin(env)}${ABUSE_QUEUE_PATH}`,
    '',
    'Further reports on the same app within the hour are added to the queue without another e-mail.',
  ];
  const sent = await deliver(to, subject, lines.join('\n'), log, { report_id: input.reportId });
  return { sent, deduped: false };
}

/** Tell the app's owners it was taken down (category only) or restored. */
export async function mailOwnersAboutModeration(
  input: { kind: 'takedown' | 'restore'; app: { slug: string; workspaceId: string }; reason: string },
  log: Logger,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const to = await appOwnerEmails(getDb(), input.app.workspaceId);
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
  return deliver(to, subject, text, log, { app: input.app.slug, kind: input.kind });
}
