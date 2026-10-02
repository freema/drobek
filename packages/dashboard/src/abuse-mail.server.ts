/**
 * The moderation e-mails, platform mail in the drobek layout
 * (renderPlatformEmail escapes the text, so a reporter's text can never
 * become markup in the operator's mail client; only the queue link, on this
 * server's origin, is a button):
 *
 *  - a new report → every super-admin (SUPERADMIN_EMAIL) and OPERATOR_EMAIL
 *    (deduplicated, case-insensitive), at most ONE mail
 *    per reported app (or unresolved host) per hour — a flood of reports on
 *    one app does not flood the operator (`drobek:abuse:mail:<key>`, Redis
 *    SET NX, 1 h; a Redis error sends anyway);
 *  - a takedown / a restore → the app's owners (its workspace's editors and
 *    workspace-admins): the reason CATEGORY and what happens next — never the
 *    reporter's text or address (@drobek/apps mailOwnersAboutModeration,
 *    re-exported here).
 *
 * Delivery errors are logged and swallowed: the report / the takedown already
 * happened and must not fail because the mailbox is down.
 */
import { ABUSE_QUEUE_PATH, dashboardOrigin, reasonLabel, type ReportedApp } from '@drobek/apps';
import { superAdminEmails } from '@drobek/auth';
import { getRedis, type Logger } from '@drobek/core';
import { dbErrorForLog } from '@drobek/db';
import { renderPlatformEmail, sendEmail, serverFootNote, type EmailAction } from '@drobek/email';

const REPORT_MAIL_DEDUP_MS = 60 * 60 * 1000;

function reportMailDedupKey(key: string): string {
  return `drobek:abuse:mail:${key}`;
}

async function firstInWindow(key: string, log: Logger): Promise<boolean> {
  try {
    const ok = await getRedis().set(reportMailDedupKey(key), '1', 'PX', REPORT_MAIL_DEDUP_MS, 'NX');
    return ok === 'OK';
  } catch (err) {
    log.warn('abuse report mail dedup unavailable — sending', { error: dbErrorForLog(err) });
    return true;
  }
}

interface ModerationMail {
  subject: string;
  text: string;
  actions?: EmailAction[];
  closing?: string;
  footNote: string;
}

async function deliver(to: string[], mail: ModerationMail, log: Logger, meta: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<number> {
  const { subject } = mail;
  let sent = 0;
  for (const address of to) {
    try {
      const r = await sendEmail({ to: address, subject, ...renderPlatformEmail(mail, env) }, env);
      if (r === 'sent') sent++;
      else log.info('abuse e-mail not sent (SMTP not configured in dev)', { ...meta, subject });
    } catch (err) {
      log.error('abuse e-mail failed', { ...meta, error: dbErrorForLog(err) });
    }
  }
  return sent;
}

/** Who hears about a report: every super-admin plus OPERATOR_EMAIL, once each (case-insensitive). */
function reportMailRecipients(env: NodeJS.ProcessEnv = process.env): string[] {
  const operator = (env.OPERATOR_EMAIL ?? '').trim().toLowerCase();
  return [...new Set([...superAdminEmails(env.SUPERADMIN_EMAIL ?? ''), ...(operator ? [operator] : [])])];
}

export interface ReportMailInput {
  reportId: string;
  host: string;
  reason: string;
  details: string;
  reporterEmail: string | null;
  app: ReportedApp | null;
}

/** Tell the super-admins and the operator about a new report (deduped per app / host per hour). */
export async function mailSuperAdminsAboutReport(
  input: ReportMailInput,
  log: Logger,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ sent: number; deduped: boolean }> {
  const to = reportMailRecipients(env);
  if (to.length === 0) {
    log.warn('abuse report stored but SUPERADMIN_EMAIL and OPERATOR_EMAIL are empty — nobody is notified', { report_id: input.reportId });
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
  ];
  const sent = await deliver(
    to,
    {
      subject,
      text: lines.join('\n'),
      actions: [{ label: 'Review the report queue', url: `${dashboardOrigin(env)}${ABUSE_QUEUE_PATH}` }],
      closing: 'Further reports on the same app within the hour are added to the queue without another e-mail.',
      footNote: serverFootNote('you moderate this server (a super-admin or OPERATOR_EMAIL)', env),
    },
    log,
    { report_id: input.reportId },
    env
  );
  return { sent, deduped: false };
}

/** The owners' takedown / restore e-mail lives in @drobek/apps (the MCP tools send it too). */
export { mailOwnersAboutModeration } from '@drobek/apps';
