/**
 * `/__drobek/v1/email/…` on every app host, and the module's mail policy:
 *
 *   POST notify-admins { subject, text }  → { sent }   (a signed-in user, EMAIL_NOTIFY_ADMINS_PER_DAY)
 *
 * `prepare` (the module's `mail` authority) runs for EVERY `ctx.email.send`
 * of every module of an app: notifications count against
 * EMAIL_PER_APP_PER_DAY, and every message gets the app's sender name and
 * Reply-To. Sign-in codes are not counted here (the auth module has its own
 * per-app hourly cap); the operator-wide hourly cap in core counts them all.
 */
import { eq } from 'drizzle-orm';
import { apps, type DB } from '@drobek/db';
import { ModuleError, z, type MailEnvelope, type MailPrepareInput, type ModuleRouter } from '@drobek/modules';
import type { EmailConfig } from './config.js';

const DAY_MS = 24 * 60 * 60_000;
const MAX_APP_NAME = 60;

/** The notifyAdmins body. Subject: one line (the core also strips control characters). */
export const notifyBody = z.strictObject({
  subject: z.string().trim().min(1, 'must not be empty').max(150),
  text: z.string().trim().min(1, 'must not be empty').max(5000),
});

/** A name that is safe on one line of plain text: no control characters, capped. */
export function oneLine(name: string, max = MAX_APP_NAME): string {
  const clean = name.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export async function appDisplayName(db: DB, appId: string, fallback: string): Promise<string> {
  const [row] = await db.select({ name: apps.name }).from(apps).where(eq(apps.id, appId)).limit(1);
  return oneLine(row?.name?.trim() || fallback) || fallback;
}

/** The e-mail the owners get for one notifyAdmins call. */
export function adminNotice(input: { appName: string; host: string | null; userEmail: string; subject: string; text: string }): {
  subject: string;
  text: string;
} {
  const where = input.host ? ` (${input.host})` : '';
  return {
    subject: `[${input.appName}] ${input.subject}`,
    text: [
      input.text,
      '',
      '—',
      `Sent from the app "${input.appName}"${where} by its signed-in user ${input.userEmail}.`,
      'You get this because you own the app on drobek (editor or workspace admin of its workspace).',
    ].join('\n'),
  };
}

/** The Host header, if it is a plain host[:port]. */
function safeHost(host: string | null): string | null {
  const h = (host ?? '').trim().toLowerCase();
  return /^[a-z0-9.-]+(?::\d{1,5})?$/.test(h) ? h : null;
}

/** The mail authority: the app's policy and envelope for every module e-mail. */
export async function prepareMail(input: MailPrepareInput<EmailConfig>): Promise<MailEnvelope> {
  if (input.kind === 'notification') {
    const max = input.limits.EMAIL_PER_APP_PER_DAY;
    const r = await input.rateLimit('app-day', 'all', max, DAY_MS);
    if (!r.ok) {
      input.log.warn('email: app daily limit reached', { app_id: input.app.id, module: input.module, limit: max });
      throw new ModuleError('limit_exceeded', `This app already sent its ${max} e-mails for today.`, {
        details: { limit: 'EMAIL_PER_APP_PER_DAY', value: max },
        headers: { 'Retry-After': String(r.retryAfterSec) },
      });
    }
  }
  const out: MailEnvelope = {};
  if (input.config.fromName) out.fromName = input.config.fromName;
  if (input.config.replyTo) out.replyTo = input.config.replyTo;
  return out;
}

export function registerRoutes(r: ModuleRouter<EmailConfig>): void {
  r.post('/notify-admins', { rule: 'user', body: notifyBody, maxBodyBytes: 8 * 1024 }, async (req, ctx) => {
    if (ctx.principal.kind !== 'user') throw new ModuleError('unauthorized', 'Sign in to this app first.');
    const max = (await ctx.limits()).EMAIL_NOTIFY_ADMINS_PER_DAY;
    const day = await ctx.rateLimit('notify-admins', 'day', max, DAY_MS);
    if (!day.ok) {
      throw new ModuleError('limit_exceeded', `This app already sent its ${max} admin notifications for today.`, {
        details: { limit: 'EMAIL_NOTIFY_ADMINS_PER_DAY', value: max },
        headers: { 'Retry-After': String(day.retryAfterSec) },
      });
    }
    const appName = await appDisplayName(ctx.db, ctx.app.id, ctx.app.slug);
    const message = adminNotice({
      appName,
      host: safeHost(req.header('host')),
      userEmail: ctx.principal.email,
      subject: req.body.subject,
      text: req.body.text,
    });
    const out = await ctx.email.send({ to: { appOwners: true }, ...message });
    ctx.log.info('email: admins notified', { app_id: ctx.app.id, recipients: out.sent });
    return { sent: out.sent };
  });
}
