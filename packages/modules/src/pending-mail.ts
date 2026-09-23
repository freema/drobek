/**
 * The e-mail to an app's owners when an agent's configure_module leaves a
 * change waiting for their confirmation (M2-02, NSO-291). Sent by the runtime
 * through the normal module e-mail path (`{ appOwners: true }`, the mail
 * authority = the `email` module, the operator-wide budgets), at most ONE per
 * app per PENDING_MAIL_WINDOW_MS; each message lists EVERYTHING that is
 * waiting for the app at that moment, so a burst of proposals is aggregated
 * into one e-mail. The dashboard banner is the always-on signal.
 */

/** At most one pending-change e-mail per app per hour. */
export const PENDING_MAIL_WINDOW_MS = 60 * 60 * 1000;

/** The rate-limit key of the per-app pending-change e-mail (`drobek:rl:` + this). */
export function pendingMailKey(appId: string): string {
  return `modules:pending-mail:${appId}`;
}

export interface PendingMailModule {
  module: string;
  changes: string[];
  /** The dashboard page where the owner reviews the module's pending change. */
  confirmUrl: string;
}

// Control and line-separator characters (U+2028/9 written as escapes on purpose).
const CONTROL_RE = new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029]+', 'g');

function oneLine(s: string, max: number): string {
  const flat = s.replace(CONTROL_RE, ' ').replace(/\s{2,}/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Subject + plain text of the pending-change e-mail (the layout escapes the text). */
export function pendingMail(input: { appName: string; modules: PendingMailModule[] }): { subject: string; text: string } {
  const name = oneLine(input.appName, 80) || 'your app';
  const total = input.modules.reduce((n, m) => n + m.changes.length, 0);
  const subject = `[${name}] ${total === 1 ? '1 change awaits' : `${total} changes await`} your confirmation`;
  const lines: string[] = [
    `An agent proposed changes to the app "${name}" that need your confirmation before they apply.`,
    'Nothing changes until you confirm them in the drobek dashboard.',
    '',
  ];
  for (const m of input.modules) {
    lines.push(`Module ${m.module}:`);
    for (const c of m.changes) lines.push(`  - ${oneLine(c, 400)}`);
    lines.push(`  Review: ${m.confirmUrl}`, '');
  }
  lines.push(
    'If you did not ask your agent for this, reject it on that page.',
    'You get at most one of these e-mails per app per hour; the app in the dashboard always shows what is waiting.'
  );
  return { subject, text: lines.join('\n') };
}
