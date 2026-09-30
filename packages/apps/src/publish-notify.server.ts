/**
 * Publish notifications: `PUBLISH_NOTIFY=first` e-mails the
 * operator (OPERATOR_EMAIL, else every super-admin) about the first publish
 * of each app, `every` about every publish — at most one e-mail per app per
 * PUBLISH_NOTIFY_EVERY_MS (`drobek:publish:notify:<app id>`, Redis SET NX; a
 * Redis error sends anyway). `off` (the default) sends nothing. A
 * super-admin's own publishes are never mailed.
 *
 * The mail (platform mail in the drobek layout) names the app, its live URL and
 * verified custom domains, the workspace, the publisher and the surface, the
 * version and whether it was the first publish, a republish or a rollback,
 * and links to the app, its dashboard page and the super-admin page where
 * the operator takes the app down or blocks the workspace.
 *
 * `publish()` calls it after the publish committed and does not wait for
 * it; every failure is logged, never thrown.
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { createConsoleLogger, getRedis, type Logger } from '@drobek/core';
import { apps, dbErrorForLog, domains, getDb, users, workspaces } from '@drobek/db';
import { renderPlatformEmail, sendEmail, serverFootNote } from '@drobek/email';
import { dashboardOrigin, publishedUrl } from './origin.js';
import {
  PUBLISH_APPROVAL_PATH,
  PUBLISH_NOTIFY_EVERY_MS,
  operatorEmails,
  publishNotifyMode,
} from './publish-approval.js';
import { isSuperAdminUser } from './publish-approval.server.js';
import type { Actor } from './types.js';

export type PublishKind = 'first' | 'republish' | 'rollback';

type Mailer = (mail: { to: string; subject: string; text: string; html: string }) => Promise<boolean>;

const defaultMailer = (env: NodeJS.ProcessEnv): Mailer => async (mail) => (await sendEmail(mail, env)) === 'sent';

/** true = the first publish e-mail of this app in the window (SET NX); a Redis error counts as true. */
type Dedupe = (appId: string) => Promise<boolean>;

const redisDedupe = (log: Logger): Dedupe => async (appId) => {
  try {
    return (await getRedis().set(`drobek:publish:notify:${appId}`, '1', 'PX', PUBLISH_NOTIFY_EVERY_MS, 'NX')) === 'OK';
  } catch (err) {
    log.warn('publish notification dedup unavailable — sending', { error: dbErrorForLog(err) });
    return true;
  }
};

export interface PublishNotifyInput {
  appId: string;
  version: number;
  kind: PublishKind;
  actor: Actor;
  env?: NodeJS.ProcessEnv;
  log?: Logger;
  send?: Mailer;
  dedupe?: Dedupe;
}

export type PublishNotifyResult =
  | { status: 'sent'; mailed: number }
  | { status: 'skipped'; reason: 'off' | 'not_first' | 'no_recipients' | 'super_admin' | 'deduped' | 'gone' | 'failed' };

const KIND_LABEL: Record<PublishKind, string> = {
  first: 'first publish',
  republish: 'republish',
  rollback: 'rollback to an older version',
};

/** E-mail the operator about a publish that just happened (see the module comment). Never throws. */
export async function notifyOperatorOfPublish(input: PublishNotifyInput): Promise<PublishNotifyResult> {
  const env = input.env ?? process.env;
  const log = input.log ?? createConsoleLogger('publish-notify');
  try {
    const mode = publishNotifyMode(env);
    if (mode === 'off') return { status: 'skipped', reason: 'off' };
    if (mode === 'first' && input.kind !== 'first') return { status: 'skipped', reason: 'not_first' };
    const to = operatorEmails(env);
    if (to.length === 0) return { status: 'skipped', reason: 'no_recipients' };
    const db = getDb();
    if (await isSuperAdminUser(db, input.actor.userId, env)) return { status: 'skipped', reason: 'super_admin' };

    const [row] = await db
      .select({ slug: apps.slug, name: apps.name, wsSlug: workspaces.slug, wsName: workspaces.name })
      .from(apps)
      .innerJoin(workspaces, eq(workspaces.id, apps.workspaceId))
      .where(eq(apps.id, input.appId))
      .limit(1);
    if (!row) return { status: 'skipped', reason: 'gone' };
    if (mode === 'every' && !(await (input.dedupe ?? redisDedupe(log))(input.appId))) {
      return { status: 'skipped', reason: 'deduped' };
    }
    const [publisher] = input.actor.userId
      ? await db.select({ email: users.email }).from(users).where(eq(users.id, input.actor.userId)).limit(1)
      : [];
    const hosts = await db
      .select({ hostname: domains.hostname })
      .from(domains)
      .where(and(eq(domains.appId, input.appId), isNotNull(domains.verifiedAt)))
      .orderBy(domains.hostname);

    const name = row.name ?? row.slug;
    const live = publishedUrl(row.slug, env);
    const origin = dashboardOrigin(env);
    const moderate = `${origin}${PUBLISH_APPROVAL_PATH}?workspace=${encodeURIComponent(row.wsSlug)}`;
    const by = publisher?.email ?? 'a user who no longer exists';
    const via = input.actor.kind === 'agent' ? 'over MCP (a coding agent)' : 'in the dashboard';
    const verb = input.kind === 'first' ? 'published' : input.kind === 'rollback' ? 'rolled back' : 'republished';
    const subject =
      input.kind === 'first' ? `New app published: ${name} (${row.slug})` : `App ${verb}: ${name} (${row.slug})`;
    const rendered = renderPlatformEmail(
      {
        subject,
        text: [
          `${by} ${verb} ${name} on your drobek server ${via}.`,
          '',
          `App: ${name} (${row.slug})`,
          `Live: ${live}`,
          ...(hosts.length > 0 ? [`Custom domains: ${hosts.map((h) => h.hostname).join(', ')}`] : []),
          `Workspace: ${row.wsName} (${row.wsSlug})`,
          `Published by: ${by}, ${via}`,
          `Version: ${input.version} (${KIND_LABEL[input.kind]})`,
          '',
          `Open the app: ${live}`,
        ].join('\n'),
        actions: [
          { label: 'The app in the dashboard', url: `${origin}/workspaces/${encodeURIComponent(row.wsSlug)}/apps/${encodeURIComponent(row.slug)}` },
          { label: 'Take the app down', url: `${moderate}#app-${row.slug}` },
          { label: 'Turn publishing off for the workspace', url: moderate },
        ],
        closing:
          mode === 'every'
            ? 'You get an e-mail about every publish (PUBLISH_NOTIFY=every); further publishes of this app within the hour are not e-mailed.'
            : 'You get an e-mail about the first publish of each app (PUBLISH_NOTIFY=first).',
        footNote: serverFootNote('you are its operator (OPERATOR_EMAIL or a super-admin)', env),
      },
      env
    );

    const send = input.send ?? defaultMailer(env);
    let mailed = 0;
    for (const address of to) {
      try {
        if (await send({ to: address, subject, ...rendered })) mailed++;
        else log.info('publish notification not e-mailed (SMTP not configured in dev)', { app_id: input.appId });
      } catch (err) {
        log.error('publish notification e-mail failed', { app_id: input.appId, error: dbErrorForLog(err) });
      }
    }
    log.info('publish notification', { event: 'publish_notify', app_id: input.appId, kind: input.kind, mailed });
    return { status: 'sent', mailed };
  } catch (err) {
    log.error('publish notification failed', { app_id: input.appId, error: dbErrorForLog(err) });
    return { status: 'skipped', reason: 'failed' };
  }
}
