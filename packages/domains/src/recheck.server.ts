/**
 * The daily DNS re-check of verified custom domains (M3-01).
 *
 * A sweep (every DOMAINS_RECHECK_INTERVAL_MS, default hourly, one replica at a
 * time through a Redis lease) re-checks every VERIFIED domain last checked
 * 24 h+ ago — so each domain is checked about once a day, whatever the
 * process restarts. Outcomes:
 *   - both records still there   → `last_check_at` refreshed, `last_error` cleared;
 *   - a lookup failed transiently → `last_check_at` + `last_error`, still verified
 *     (a resolver hiccup never takes a site down);
 *   - a record is gone / wrong    → `verified_at` null (and no longer primary),
 *     audited `domain.unverify` (system), the app stops serving on that name
 *     and Caddy gets no NEW certificate for it, and the app's owners (editors
 *     + workspace-admins) get ONE e-mail — the domain is no longer verified,
 *     so later sweeps skip it until someone verifies it again.
 */
import { and, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { appsOrigin, dashboardOrigin, notifyAppChanged, withRedisLock } from '@drobek/apps';
import { AUDIT_ACTIONS, AUDIT_SUBJECT_TYPES, writeAudit } from '@drobek/audit';
import { apps, dbErrorForLog, domains, getDb, memberships, users, workspaces } from '@drobek/db';
import { renderTextEmailHtml, sendEmail } from '@drobek/email';
import { RECHECK_AFTER_MS, domainsResolver, recheckIntervalMs } from './config.js';
import { checkDomainDns, type DnsResolver } from './dns.js';
import { cnameTarget, verificationRecordName } from './hostname.js';

const LOCK_KEY = 'drobek:lock:domains-recheck';
const BATCH = 200;
const CONCURRENCY = 8;

export interface DomainLostNotice {
  to: string;
  subject: string;
  text: string;
}

export interface RecheckOptions {
  resolver?: DnsResolver;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Deliver one owner notice (default: SMTP through @drobek/email). */
  sendNotice?: (notice: DomainLostNotice) => Promise<void>;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  timeoutMs?: number;
}

export interface RecheckResult {
  checked: number;
  /** Verifications dropped (records gone). */
  dropped: number;
  /** Checks that could not complete (verification kept). */
  transient: number;
}

/** The addresses of an app's owners: the editors and workspace-admins of its workspace. */
export async function appOwnerAddresses(workspaceId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.workspaceId, workspaceId), inArray(memberships.role, ['editor', 'workspace-admin'])));
  return [...new Set(rows.map((r) => r.email.trim().toLowerCase()))];
}

async function defaultSendNotice(notice: DomainLostNotice, env: NodeJS.ProcessEnv): Promise<void> {
  const html = renderTextEmailHtml({
    subject: notice.subject,
    text: notice.text,
    footNote: 'You get this because you can edit this app on drobek.',
  });
  await sendEmail({ to: notice.to, subject: notice.subject, text: notice.text, html }, env);
}

export function domainLostText(input: { hostname: string; appSlug: string; reason: string | null; manageUrl: string; cnameTarget: string }): {
  subject: string;
  text: string;
} {
  return {
    subject: `Custom domain ${input.hostname} is no longer verified`,
    text: [
      `The daily DNS check of ${input.hostname} (app ${input.appSlug}) failed:`,
      input.reason ?? 'the DNS records are missing.',
      '',
      `drobek stopped serving the app on ${input.hostname}. It is still available on its drobek address.`,
      'To bring the domain back, restore both DNS records and click "Verify" on the Domains page:',
      `  CNAME ${input.hostname} → ${input.cnameTarget}`,
      `  TXT   ${verificationRecordName(input.hostname)} = drobek-verify=… (the value shown on the Domains page)`,
      '',
      input.manageUrl,
    ].join('\n'),
  };
}

/** One sweep: re-check the verified domains that are due. */
export async function recheckDueDomains(opts: RecheckOptions = {}): Promise<RecheckResult> {
  const env = opts.env ?? process.env;
  const now = (opts.now ?? (() => new Date()))();
  const resolver = opts.resolver ?? domainsResolver(env);
  const send = opts.sendNotice ?? ((n: DomainLostNotice) => defaultSendNotice(n, env));
  const appsDomain = appsOrigin(env).domain;
  const cutoff = new Date(now.getTime() - RECHECK_AFTER_MS);

  const due = await getDb()
    .select({
      id: domains.id,
      hostname: domains.hostname,
      token: domains.verificationToken,
      appId: apps.id,
      slug: apps.slug,
      workspaceId: apps.workspaceId,
      workspaceSlug: workspaces.slug,
    })
    .from(domains)
    .innerJoin(apps, eq(apps.id, domains.appId))
    .innerJoin(workspaces, eq(workspaces.id, apps.workspaceId))
    .where(
      and(
        isNotNull(domains.verifiedAt),
        isNull(apps.deletedAt),
        or(isNull(domains.lastCheckAt), lt(domains.lastCheckAt, cutoff))
      )
    )
    .orderBy(domains.lastCheckAt)
    .limit(BATCH);

  const result: RecheckResult = { checked: 0, dropped: 0, transient: 0 };
  let next = 0;
  const worker = async () => {
    while (next < due.length) {
      const d = due[next++];
      const target = cnameTarget(d.slug, appsDomain);
      const check = await checkDomainDns(resolver, { hostname: d.hostname, token: d.token, cnameTarget: target }, { timeoutMs: opts.timeoutMs });
      result.checked++;
      if (check.ok || check.transient) {
        if (check.transient) result.transient++;
        await getDb()
          .update(domains)
          .set({ lastCheckAt: now, lastError: check.error })
          .where(eq(domains.id, d.id));
        continue;
      }
      // Definitive: drop the verification — only if it is still verified (a
      // concurrent sweep or a manual check may have got there first: one e-mail).
      const dropped = await getDb()
        .update(domains)
        .set({ verifiedAt: null, isPrimary: false, lastCheckAt: now, lastError: check.error })
        .where(and(eq(domains.id, d.id), isNotNull(domains.verifiedAt)))
        .returning({ id: domains.id });
      if (dropped.length === 0) continue;
      result.dropped++;
      await writeAudit({
        workspaceId: d.workspaceId,
        actorUserId: null,
        actorKind: 'user',
        action: AUDIT_ACTIONS.domainUnverify,
        subjectType: AUDIT_SUBJECT_TYPES.domain,
        target: d.hostname,
        meta: { app: d.slug, app_id: d.appId, by: 'dns_recheck', reason: check.error },
      });
      await notifyAppChanged({ app_id: d.appId, slug: d.slug, kind: 'domain' });
      opts.log?.('custom domain lost its verification', { app_id: d.appId, hostname: d.hostname, txt: check.txt, target: check.target });

      const manageUrl = `${dashboardOrigin(env)}/workspaces/${d.workspaceSlug}/apps/${d.slug}/domains`;
      const message = domainLostText({ hostname: d.hostname, appSlug: d.slug, reason: check.error, manageUrl, cnameTarget: target });
      for (const to of await appOwnerAddresses(d.workspaceId)) {
        try {
          await send({ to, ...message });
        } catch (err) {
          opts.log?.('custom domain notice not sent', { app_id: d.appId, error: dbErrorForLog(err) });
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, worker));
  return result;
}

/**
 * The re-check timer in the server process (first sweep a minute after the
 * start, then every DOMAINS_RECHECK_INTERVAL_MS). Returns a stop function.
 */
export function startDomainRecheck(
  log: (msg: string, meta?: Record<string, unknown>, error?: string) => void,
  env: NodeJS.ProcessEnv = process.env
): () => void {
  const interval = recheckIntervalMs(env);
  const leaseSec = Math.max(600, Math.ceil(interval / 1000));
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const out = await withRedisLock(LOCK_KEY, leaseSec, () => recheckDueDomains({ env, log: (m, meta) => log(m, meta) }));
      if (out.acquired && (out.result.dropped > 0 || out.result.transient > 0)) {
        log('custom domain re-check', { ...out.result });
      }
    } catch (err) {
      log('custom domain re-check failed', undefined, dbErrorForLog(err));
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void run(), Math.min(60_000, interval));
  first.unref();
  const timer = setInterval(() => void run(), interval);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
