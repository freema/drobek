/**
 * Custom domains of one app (M3-01): list, add, verify, make primary, remove.
 *
 * Callers authorize first (the dashboard route: editor+ of the app's
 * workspace) and pass the app they resolved; every query here is scoped by
 * `app.id`, so a domain id of another app is simply `not_found`.
 *
 * Every change is audited (`domain.add` / `domain.verify` / `domain.unverify`
 * / `domain.primary` / `domain.remove`, subject `domain`, target = hostname)
 * and announced as an app-changed event of kind `domain`, which drops the
 * serve cache's custom-host and app resolutions (@drobek/serving) — a verified
 * domain serves, and a removed one stops serving, from the next request.
 */
import { randomBytes } from 'node:crypto';
import { and, count, eq, isNotNull, ne } from 'drizzle-orm';
import { appsOrigin, notifyAppChanged, type AppChangedEvent } from '@drobek/apps';
import { AUDIT_ACTIONS, AUDIT_SUBJECT_TYPES, writeAudit, type AuditActorKind } from '@drobek/audit';
import { apps, domains, getDb } from '@drobek/db';
import { domainsMaxPerApp, domainsResolver, hostnameRules } from './config.js';
import { checkDomainDns, type DnsResolver, type DomainDnsResult } from './dns.js';
import { DomainsError } from './errors.js';
import { checkHostname, cnameTarget, verificationRecordName, verificationRecordValue } from './hostname.js';

export interface DomainApp {
  id: string;
  slug: string;
  workspaceId: string;
}

export interface DomainActor {
  /** The acting user (null only for system actions such as the re-check). */
  userId: string | null;
  kind: AuditActorKind;
}

export interface DomainInstructions {
  cname: { name: string; value: string };
  txt: { name: string; value: string };
}

export interface DomainView {
  id: string;
  hostname: string;
  verified: boolean;
  verifiedAt: Date | null;
  lastCheckAt: Date | null;
  lastError: string | null;
  certState: string;
  isPrimary: boolean;
  createdAt: Date;
  /** The two DNS records the owner creates. */
  instructions: DomainInstructions;
}

type DomainRow = typeof domains.$inferSelect;

/** A fresh verification token: 32 hex characters (it is proof of control, not a secret). */
export function newVerificationToken(): string {
  return randomBytes(16).toString('hex');
}

export function instructionsFor(row: { hostname: string; verificationToken: string }, slug: string, appsDomain: string): DomainInstructions {
  return {
    cname: { name: row.hostname, value: cnameTarget(slug, appsDomain) },
    txt: { name: verificationRecordName(row.hostname), value: verificationRecordValue(row.verificationToken) },
  };
}

function view(row: DomainRow, app: DomainApp, appsDomain: string): DomainView {
  return {
    id: row.id,
    hostname: row.hostname,
    verified: row.verifiedAt !== null,
    verifiedAt: row.verifiedAt,
    lastCheckAt: row.lastCheckAt,
    lastError: row.lastError,
    certState: row.certState,
    isPrimary: row.isPrimary,
    createdAt: row.createdAt,
    instructions: instructionsFor(row, app.slug, appsDomain),
  };
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

async function announce(app: DomainApp): Promise<void> {
  const event: AppChangedEvent = { app_id: app.id, slug: app.slug, kind: 'domain' };
  await notifyAppChanged(event);
}

async function audit(
  app: DomainApp,
  actor: DomainActor,
  action: string,
  hostname: string,
  meta: Record<string, unknown> = {}
): Promise<void> {
  await writeAudit({
    workspaceId: app.workspaceId,
    actorUserId: actor.userId,
    actorKind: actor.kind,
    action,
    subjectType: AUDIT_SUBJECT_TYPES.domain,
    target: hostname,
    meta: { app: app.slug, app_id: app.id, ...meta },
  });
}

async function loadRow(app: DomainApp, domainId: string): Promise<DomainRow> {
  const [row] = await getDb()
    .select()
    .from(domains)
    .where(and(eq(domains.id, String(domainId ?? '')), eq(domains.appId, app.id)))
    .limit(1);
  if (!row) throw new DomainsError('not_found', 'No such domain on this app.');
  return row;
}

/** The app's domains, oldest first, with their DNS instructions. */
export async function listDomains(app: DomainApp, env: NodeJS.ProcessEnv = process.env): Promise<DomainView[]> {
  const rows = await getDb().select().from(domains).where(eq(domains.appId, app.id)).orderBy(domains.createdAt, domains.hostname);
  const appsDomain = appsOrigin(env).domain;
  return rows.map((r) => view(r, app, appsDomain));
}

/**
 * Attach `rawHostname` to the app (unverified). Refuses an invalid or
 * drobek-owned name, a name the app already has, a name another app has
 * VERIFIED (`domain_taken`) and the (DOMAINS_MAX_PER_APP + 1)-th domain
 * (`limit_exceeded`; with a limit of 0 every add is refused — custom domains
 * are off for the workspace). An unverified claim elsewhere does not block:
 * only DNS decides who owns a name. `opts.maxPerApp` is the workspace's
 * effective DOMAINS_MAX_PER_APP (the limits provider's plan); default: the env.
 */
function domainsDisabled(): DomainsError {
  return new DomainsError('limit_exceeded', 'Custom domains are not available for this workspace (DOMAINS_MAX_PER_APP is 0).', {
    limit: 'DOMAINS_MAX_PER_APP',
    value: 0,
  });
}

export async function addDomain(
  app: DomainApp,
  rawHostname: unknown,
  actor: DomainActor,
  env: NodeJS.ProcessEnv = process.env,
  opts: { maxPerApp?: number } = {}
): Promise<DomainView> {
  const max = opts.maxPerApp ?? domainsMaxPerApp(env);
  if (max <= 0) throw domainsDisabled();
  const checked = checkHostname(rawHostname, hostnameRules(env));
  if (!checked.ok) throw new DomainsError(checked.code, checked.message);
  const hostname = checked.hostname;

  let row: DomainRow;
  try {
    row = await getDb().transaction(async (tx) => {
      // Serialize adds per app so two concurrent requests cannot both pass the limit.
      await tx.select({ id: apps.id }).from(apps).where(eq(apps.id, app.id)).for('update');
      const [dup] = await tx
        .select({ id: domains.id })
        .from(domains)
        .where(and(eq(domains.appId, app.id), eq(domains.hostname, hostname)))
        .limit(1);
      if (dup) throw new DomainsError('already_added', `${hostname} is already a domain of this app.`);
      const [taken] = await tx
        .select({ id: domains.id })
        .from(domains)
        .where(and(eq(domains.hostname, hostname), isNotNull(domains.verifiedAt), ne(domains.appId, app.id)))
        .limit(1);
      if (taken) throw new DomainsError('domain_taken', `${hostname} is already verified for another app.`);
      const [{ n }] = await tx.select({ n: count() }).from(domains).where(eq(domains.appId, app.id));
      if (Number(n) >= max) {
        throw new DomainsError('limit_exceeded', `An app can have at most ${max} custom domain${max === 1 ? '' : 's'} (DOMAINS_MAX_PER_APP).`, {
          limit: 'DOMAINS_MAX_PER_APP',
          value: max,
        });
      }
      const [inserted] = await tx
        .insert(domains)
        .values({ appId: app.id, hostname, verificationToken: newVerificationToken() })
        .returning();
      return inserted;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainsError('already_added', `${hostname} is already a domain of this app.`);
    throw err;
  }
  await audit(app, actor, AUDIT_ACTIONS.domainAdd, hostname);
  await announce(app);
  return view(row, app, appsOrigin(env).domain);
}

export interface VerifyOptions {
  resolver?: DnsResolver;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  timeoutMs?: number;
}

export interface VerifyOutcome {
  domain: DomainView;
  check: DomainDnsResult;
  /** true when this call verified a domain that was not verified before. */
  newlyVerified: boolean;
  /** true when this call dropped an existing verification (records gone). */
  unverified: boolean;
}

/**
 * Look the domain's two records up now and store the verdict. Passing →
 * `verified_at` (audited `domain.verify` the first time). Failing → the
 * reason in `last_error`; a verified domain whose records are definitively
 * gone loses its verification (audited `domain.unverify`); a transient DNS
 * failure never changes the state.
 */
export async function verifyDomain(app: DomainApp, domainId: string, actor: DomainActor, opts: VerifyOptions = {}): Promise<VerifyOutcome> {
  const env = opts.env ?? process.env;
  const now = (opts.now ?? (() => new Date()))();
  const row = await loadRow(app, domainId);
  const appsDomain = appsOrigin(env).domain;
  const check = await checkDomainDns(
    opts.resolver ?? domainsResolver(env),
    { hostname: row.hostname, token: row.verificationToken, cnameTarget: cnameTarget(app.slug, appsDomain) },
    { timeoutMs: opts.timeoutMs }
  );

  let newlyVerified = false;
  let unverified = false;
  let updated: DomainRow | undefined;
  if (check.ok) {
    try {
      updated = await getDb().transaction(async (tx) => {
        const [taken] = await tx
          .select({ id: domains.id })
          .from(domains)
          .where(and(eq(domains.hostname, row.hostname), isNotNull(domains.verifiedAt), ne(domains.id, row.id)))
          .limit(1);
        if (taken) throw new DomainsError('domain_taken', `${row.hostname} is already verified for another app.`);
        const [u] = await tx
          .update(domains)
          .set({ verifiedAt: row.verifiedAt ?? now, lastCheckAt: now, lastError: null })
          .where(eq(domains.id, row.id))
          .returning();
        return u;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new DomainsError('domain_taken', `${row.hostname} is already verified for another app.`);
      throw err;
    }
    newlyVerified = row.verifiedAt === null;
  } else {
    const drop = row.verifiedAt !== null && !check.transient;
    [updated] = await getDb()
      .update(domains)
      .set({
        lastCheckAt: now,
        lastError: check.error,
        ...(drop ? { verifiedAt: null, isPrimary: false } : {}),
      })
      .where(eq(domains.id, row.id))
      .returning();
    unverified = drop;
  }

  if (newlyVerified) await audit(app, actor, AUDIT_ACTIONS.domainVerify, row.hostname);
  if (unverified) await audit(app, actor, AUDIT_ACTIONS.domainUnverify, row.hostname, { by: 'check', reason: check.error });
  if (newlyVerified || unverified) await announce(app);
  return { domain: view(updated ?? row, app, appsDomain), check, newlyVerified, unverified };
}

/**
 * Make a VERIFIED domain the app's primary one — `<slug>.<APPS_DOMAIN>` then
 * answers 302 to it — or clear the primary (`domainId` null). Audited
 * `domain.primary`.
 */
export async function setPrimaryDomain(app: DomainApp, domainId: string | null, actor: DomainActor): Promise<void> {
  let hostname: string | null = null;
  await getDb().transaction(async (tx) => {
    if (domainId !== null) {
      const [row] = await tx
        .select()
        .from(domains)
        .where(and(eq(domains.id, String(domainId)), eq(domains.appId, app.id)))
        .limit(1);
      if (!row) throw new DomainsError('not_found', 'No such domain on this app.');
      if (row.verifiedAt === null) throw new DomainsError('not_verified', 'Verify the domain before making it primary.');
      hostname = row.hostname;
    }
    await tx.update(domains).set({ isPrimary: false }).where(and(eq(domains.appId, app.id), eq(domains.isPrimary, true)));
    if (domainId !== null) await tx.update(domains).set({ isPrimary: true }).where(eq(domains.id, String(domainId)));
  });
  await audit(app, actor, AUDIT_ACTIONS.domainPrimary, hostname ?? '', { primary: hostname });
  await announce(app);
}

/**
 * Detach a domain. It stops serving at once (cache bust); Caddy keeps the
 * certificate it already has until it expires (no revocation — documented).
 */
export async function removeDomain(app: DomainApp, domainId: string, actor: DomainActor): Promise<{ hostname: string }> {
  const row = await loadRow(app, domainId);
  await getDb().delete(domains).where(and(eq(domains.id, row.id), eq(domains.appId, app.id)));
  await audit(app, actor, AUDIT_ACTIONS.domainRemove, row.hostname, { was_verified: row.verifiedAt !== null });
  await announce(app);
  return { hostname: row.hostname };
}
