/**
 * Abuse and moderation, the stateful half (M4-02, NSO-293):
 *
 *  - the report queue (`abuse_reports`): `createAbuseReport` (the public form
 *    on the dashboard origin), `listAbuseReports`, `resolveAbuseReport`;
 *  - the takedown (`apps.locked_reason`): `takedownApp` unpublishes the app
 *    and locks it in one transaction (audit `admin.takedown`),
 *    `restoreApp` lifts the lock WITHOUT republishing (audit `admin.restore`);
 *    both bust the serve cache (`notifyAppChanged`), so every host of the app
 *    answers 451 / stops answering 451 on the next request;
 *  - the publish heuristic (`screenPublishedVersion`): scans the published
 *    version for a password field + a foreign brand word and files a
 *    `heuristic` report — never a block (see heuristic.ts).
 *
 * The lock itself is enforced in versions.server.ts (createVersion, publish,
 * restore refuse with `app_locked_by_admin`) and by every caller that changes
 * an app another way (MCP configure_module, the dashboard APIs).
 *
 * E-mail (super-admins on a report, owners on a takedown/restore) is the
 * dashboard's business — this package sends none.
 */
import { createHmac } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { AUDIT_ACTIONS, writeAudit } from '@drobek/audit';
import { createConsoleLogger, type Logger } from '@drobek/core';
import { abuseReports, appVersions, apps, blobs, domains, getDb, users, versionFiles, workspaces } from '@drobek/db';
import { AppsError } from './errors.js';
import { notifyAppChanged } from './events.js';
import { brandWordsFromEnv, describeFinding, scanForPhishing, type HeuristicFinding } from './heuristic.js';
import { appHostOf, classifyHost, type HostConfig } from './host.js';
import {
  REPORT_DETAILS_MAX,
  isLockReason,
  lockCategory,
  normalizeReportHost,
  type LockReason,
  type ReportReason,
} from './moderation.js';
import { appsOrigin, hostConfig } from './origin.js';

// ── lock state ───────────────────────────────────────────────────────────────

export interface AppLockState {
  locked: boolean;
  /** The takedown category (null when not locked). */
  reason: LockReason | null;
}

/** Whether an app is taken down, and why (category only). Unknown app → not locked. */
export async function appLockState(appId: string): Promise<AppLockState> {
  const [row] = await getDb().select({ lockedReason: apps.lockedReason }).from(apps).where(eq(apps.id, appId)).limit(1);
  if (!row?.lockedReason) return { locked: false, reason: null };
  return { locked: true, reason: lockCategory(row.lockedReason) };
}

/** The AppsError every refused change of a locked app throws. */
export function lockedByAdminError(lockedReason: string | null | undefined): AppsError {
  const category = lockCategory(lockedReason);
  return new AppsError(
    'app_locked_by_admin',
    `This app was taken down by the server operator (reason: ${category}). It cannot be changed, published or reconfigured until an operator restores it.`,
    { reason: category }
  );
}

// ── takedown / restore ───────────────────────────────────────────────────────

export interface ModerationTarget {
  appId: string;
  slug: string;
  workspaceId: string;
}

/**
 * Take an app down: `locked_reason = reason`, `published_version_id = null`
 * (the production host stops serving; preview/version hosts answer 451 like
 * it), every open report of the app resolved — one transaction, audited
 * `admin.takedown` (meta: reason, the unpublished version id). Idempotent:
 * taking a locked app down again only updates the category.
 */
export async function takedownApp(input: {
  appId: string;
  reason: string;
  actorUserId: string;
  log?: Logger;
}): Promise<ModerationTarget & { unpublishedVersionId: string | null; alreadyLocked: boolean }> {
  if (!isLockReason(input.reason)) {
    throw new AppsError('invalid_reason', `Unknown takedown reason "${input.reason}".`);
  }
  const reason = input.reason;
  const out = await getDb().transaction(async (tx) => {
    const [app] = await tx
      .select({
        id: apps.id,
        slug: apps.slug,
        workspaceId: apps.workspaceId,
        publishedVersionId: apps.publishedVersionId,
        lockedReason: apps.lockedReason,
      })
      .from(apps)
      .where(and(eq(apps.id, input.appId), isNull(apps.deletedAt)))
      .for('update');
    if (!app) throw new AppsError('not_found', `App ${input.appId} does not exist.`);
    await tx.update(apps).set({ lockedReason: reason, publishedVersionId: null }).where(eq(apps.id, app.id));
    const resolved = await tx
      .update(abuseReports)
      .set({ status: 'resolved', resolvedAt: sql`now()`, resolvedBy: input.actorUserId })
      .where(and(eq(abuseReports.appId, app.id), eq(abuseReports.status, 'open')))
      .returning({ id: abuseReports.id });
    await writeAudit(
      {
        workspaceId: app.workspaceId,
        actorUserId: input.actorUserId,
        actorKind: 'user',
        action: AUDIT_ACTIONS.adminTakedown,
        subjectType: 'app',
        target: app.slug,
        meta: {
          reason,
          unpublishedVersionId: app.publishedVersionId,
          reportsResolved: resolved.length,
          ...(app.lockedReason ? { previousReason: app.lockedReason } : {}),
        },
      },
      tx
    );
    return {
      appId: app.id,
      slug: app.slug,
      workspaceId: app.workspaceId,
      unpublishedVersionId: app.publishedVersionId,
      alreadyLocked: app.lockedReason !== null,
    };
  });
  await notifyAppChanged({ app_id: out.appId, slug: out.slug, kind: 'settings' }, input.log);
  return out;
}

/**
 * Lift a takedown: `locked_reason = null`. The app is NOT republished — its
 * owner publishes again when ready (the production host keeps answering
 * "not published"). Audited `admin.restore` (meta: the lifted reason).
 * Restoring an app that is not locked is a no-op (`wasLocked: false`, no audit).
 */
export async function restoreApp(input: {
  appId: string;
  actorUserId: string;
  log?: Logger;
}): Promise<ModerationTarget & { wasLocked: boolean; reason: LockReason | null }> {
  const out = await getDb().transaction(async (tx) => {
    const [app] = await tx
      .select({ id: apps.id, slug: apps.slug, workspaceId: apps.workspaceId, lockedReason: apps.lockedReason })
      .from(apps)
      .where(and(eq(apps.id, input.appId), isNull(apps.deletedAt)))
      .for('update');
    if (!app) throw new AppsError('not_found', `App ${input.appId} does not exist.`);
    const base = { appId: app.id, slug: app.slug, workspaceId: app.workspaceId };
    if (app.lockedReason === null) return { ...base, wasLocked: false, reason: null };
    await tx.update(apps).set({ lockedReason: null }).where(eq(apps.id, app.id));
    const reason = lockCategory(app.lockedReason);
    await writeAudit(
      {
        workspaceId: app.workspaceId,
        actorUserId: input.actorUserId,
        actorKind: 'user',
        action: AUDIT_ACTIONS.adminRestore,
        subjectType: 'app',
        target: app.slug,
        meta: { reason },
      },
      tx
    );
    return { ...base, wasLocked: true, reason };
  });
  if (out.wasLocked) await notifyAppChanged({ app_id: out.appId, slug: out.slug, kind: 'settings' }, input.log);
  return out;
}

// ── reports ──────────────────────────────────────────────────────────────────

export interface ReportedApp {
  id: string;
  slug: string;
  name: string | null;
  workspaceId: string;
  workspaceSlug: string;
  lockedReason: string | null;
}

const reportedAppColumns = {
  id: apps.id,
  slug: apps.slug,
  name: apps.name,
  workspaceId: apps.workspaceId,
  workspaceSlug: workspaces.slug,
  lockedReason: apps.lockedReason,
};

/**
 * The live app a reported host belongs to (`<slug>`, `<slug>--preview`,
 * `<slug>--v<N>` under APPS_DOMAIN, or a VERIFIED custom domain — M3-01), or
 * null — a host outside the apps origin that no verified domain names, a
 * malformed label, or no such (live) app.
 */
export async function findAppByReportedHost(host: string, hosts: HostConfig = hostConfig()): Promise<ReportedApp | null> {
  const cls = classifyHost(host, hosts);
  if (cls.side === 'custom') {
    // The domains table directly (@drobek/domains depends on this package):
    // the same rule as its resolveCustomHost — only a verified row serves the app.
    const [row] = await getDb()
      .select(reportedAppColumns)
      .from(domains)
      .innerJoin(apps, eq(apps.id, domains.appId))
      .innerJoin(workspaces, eq(workspaces.id, apps.workspaceId))
      .where(and(eq(domains.hostname, cls.hostname), isNotNull(domains.verifiedAt), isNull(apps.deletedAt)))
      .limit(1);
    return row ?? null;
  }
  if (cls.side !== 'apps' || !cls.target) return null;
  const [row] = await getDb()
    .select(reportedAppColumns)
    .from(apps)
    .innerJoin(workspaces, eq(workspaces.id, apps.workspaceId))
    .where(and(eq(apps.slug, cls.target.slug), isNull(apps.deletedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * A keyed hash of the reporter's IP (HMAC-SHA256 under DROBEK_MASTER_KEY):
 * enough to spot one address filing many reports, useless for recovering it.
 */
export function reportIpHash(ip: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!ip) return null;
  const key = env.DROBEK_MASTER_KEY || 'drobek-dev-abuse-ip';
  return createHmac('sha256', key).update(`abuse-report-ip:${ip}`).digest('hex').slice(0, 32);
}

const EMAIL_RE = /^[^\s@<>()[\],;:"]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,}$/i;

export interface AbuseReportInput {
  host: string;
  reason: string;
  details?: string | null;
  reporterEmail?: string | null;
  clientIp?: string | null;
}

export type AbuseReportValidation =
  | { ok: true; value: { host: string; reason: ReportReason; details: string; reporterEmail: string | null } }
  | { ok: false; field: 'host' | 'reason' | 'details' | 'reporterEmail'; message: string };

/** Validate a public report (the form's own checks, before anything is stored). */
export function validateAbuseReport(input: AbuseReportInput): AbuseReportValidation {
  const host = normalizeReportHost(input.host);
  if (!host) return { ok: false, field: 'host', message: 'Enter the address of the app (e.g. my-app.example.com).' };
  if (!isLockReason(input.reason)) return { ok: false, field: 'reason', message: 'Pick a reason.' };
  const details = String(input.details ?? '').replace(/\r\n/g, '\n').trim();
  if (details.length > REPORT_DETAILS_MAX) {
    return { ok: false, field: 'details', message: `Details can be at most ${REPORT_DETAILS_MAX} characters.` };
  }
  const email = String(input.reporterEmail ?? '').trim();
  if (email && (email.length > 254 || !EMAIL_RE.test(email))) {
    return { ok: false, field: 'reporterEmail', message: 'Enter a valid e-mail address, or leave it empty.' };
  }
  return { ok: true, value: { host, reason: input.reason, details, reporterEmail: email ? email.toLowerCase() : null } };
}

/**
 * Store a validated public report. The app behind the host is resolved (null
 * when none — the report is kept anyway, the operator sees the host). When
 * the app resolved, the report is audited `abuse.report` in its workspace
 * (report id + reason only: no reporter data).
 */
export async function createAbuseReport(
  input: AbuseReportInput,
  opts: { hosts?: HostConfig; env?: NodeJS.ProcessEnv } = {}
): Promise<{ id: string; host: string; reason: ReportReason; app: ReportedApp | null }> {
  const v = validateAbuseReport(input);
  if (!v.ok) throw new AppsError('invalid_reason', v.message);
  const app = await findAppByReportedHost(v.value.host, opts.hosts);
  const id = await getDb().transaction(async (tx) => {
    const [row] = await tx
      .insert(abuseReports)
      .values({
        appId: app?.id ?? null,
        host: v.value.host,
        reason: v.value.reason,
        details: v.value.details,
        reporterEmail: v.value.reporterEmail,
        ipHash: reportIpHash(input.clientIp ?? null, opts.env),
      })
      .returning({ id: abuseReports.id });
    if (app) {
      await writeAudit(
        {
          workspaceId: app.workspaceId,
          actorUserId: null,
          actorKind: 'user',
          action: AUDIT_ACTIONS.abuseReport,
          subjectType: 'app',
          target: app.slug,
          meta: { reportId: row.id, reason: v.value.reason },
        },
        tx
      );
    }
    return row.id;
  });
  return { id, host: v.value.host, reason: v.value.reason, app };
}

export interface AbuseReportRow {
  id: string;
  host: string;
  reason: string;
  details: string;
  reporterEmail: string | null;
  status: 'open' | 'resolved';
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedByEmail: string | null;
  app: ReportedApp | null;
}

/** The queue: reports by status, newest first (with the app, its workspace and lock state). */
export async function listAbuseReports(opts: { status?: 'open' | 'resolved'; limit?: number } = {}): Promise<AbuseReportRow[]> {
  const status = opts.status ?? 'open';
  const rows = await getDb()
    .select({
      id: abuseReports.id,
      host: abuseReports.host,
      reason: abuseReports.reason,
      details: abuseReports.details,
      reporterEmail: abuseReports.reporterEmail,
      status: abuseReports.status,
      createdAt: abuseReports.createdAt,
      resolvedAt: abuseReports.resolvedAt,
      resolvedByEmail: users.email,
      appId: apps.id,
      appSlug: apps.slug,
      appName: apps.name,
      workspaceId: apps.workspaceId,
      workspaceSlug: workspaces.slug,
      lockedReason: apps.lockedReason,
    })
    .from(abuseReports)
    .leftJoin(apps, eq(apps.id, abuseReports.appId))
    .leftJoin(workspaces, eq(workspaces.id, apps.workspaceId))
    .leftJoin(users, eq(users.id, abuseReports.resolvedBy))
    .where(eq(abuseReports.status, status))
    .orderBy(desc(abuseReports.createdAt))
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  return rows.map((r) => ({
    id: r.id,
    host: r.host,
    reason: r.reason,
    details: r.details,
    reporterEmail: r.reporterEmail,
    status: r.status,
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
    resolvedByEmail: r.resolvedByEmail,
    app:
      r.appId && r.appSlug && r.workspaceId && r.workspaceSlug
        ? {
            id: r.appId,
            slug: r.appSlug,
            name: r.appName,
            workspaceId: r.workspaceId,
            workspaceSlug: r.workspaceSlug,
            lockedReason: r.lockedReason,
          }
        : null,
  }));
}

/** Mark one open report resolved (no other effect). false when it is not open. */
export async function resolveAbuseReport(reportId: string, actorUserId: string): Promise<boolean> {
  const rows = await getDb()
    .update(abuseReports)
    .set({ status: 'resolved', resolvedAt: sql`now()`, resolvedBy: actorUserId })
    .where(and(eq(abuseReports.id, reportId), eq(abuseReports.status, 'open')))
    .returning({ id: abuseReports.id });
  return rows.length > 0;
}

/** Every app that is currently taken down (live rows), newest first by slug order. */
export async function listLockedApps(): Promise<ReportedApp[]> {
  return getDb()
    .select(reportedAppColumns)
    .from(apps)
    .innerJoin(workspaces, eq(workspaces.id, apps.workspaceId))
    .where(and(isNotNull(apps.lockedReason), isNull(apps.deletedAt)))
    .orderBy(apps.slug);
}

/** An app by id for the queue actions (live), or null. */
export async function findModerationApp(appId: string): Promise<ReportedApp | null> {
  const [row] = await getDb()
    .select(reportedAppColumns)
    .from(apps)
    .innerJoin(workspaces, eq(workspaces.id, apps.workspaceId))
    .where(and(eq(apps.id, appId), isNull(apps.deletedAt)))
    .limit(1);
  return row ?? null;
}

// ── the publish heuristic ────────────────────────────────────────────────────

/** Files bigger than this are not scanned; the scan stops after SCAN_MAX_TOTAL bytes. */
const SCAN_MAX_FILE = 1024 * 1024;
const SCAN_MAX_TOTAL = 4 * 1024 * 1024;

export interface ScreenResult {
  finding: HeuristicFinding;
  /** The `heuristic` report filed, or null (not flagged, or an open heuristic report already exists). */
  reportId: string | null;
}

/**
 * Scan the version that was just published (its HTML + JS, built and source)
 * and file a `heuristic` report when it looks like a credential-phishing page.
 * One open heuristic report per app at a time (a re-publish does not pile up
 * the queue). Never throws into the publish: callers use `screenAfterPublish`.
 */
export async function screenPublishedVersion(
  appId: string,
  versionId: string,
  opts: { env?: NodeJS.ProcessEnv; log?: Logger } = {}
): Promise<ScreenResult> {
  const env = opts.env ?? process.env;
  const db = getDb();
  const files = await db
    .select({ path: versionFiles.path, sha256: versionFiles.sha256, size: versionFiles.size })
    .from(versionFiles)
    .where(
      and(
        eq(versionFiles.versionId, versionId),
        or(
          sql`lower(${versionFiles.path}) like '%.html'`,
          sql`lower(${versionFiles.path}) like '%.htm'`,
          sql`lower(${versionFiles.path}) like '%.js'`,
          sql`lower(${versionFiles.path}) like '%.mjs'`
        )
      )
    )
    .orderBy(versionFiles.path);
  const picked: typeof files = [];
  let total = 0;
  for (const f of files) {
    if (f.size > SCAN_MAX_FILE || total + f.size > SCAN_MAX_TOTAL) continue;
    picked.push(f);
    total += f.size;
  }
  const bytes = picked.length
    ? await db.select({ sha256: blobs.sha256, bytes: blobs.bytes }).from(blobs).where(inArray(blobs.sha256, [...new Set(picked.map((f) => f.sha256))]))
    : [];
  const bySha = new Map(bytes.map((b) => [b.sha256, b.bytes]));
  const finding = scanForPhishing(
    picked.flatMap((f) => {
      const b = bySha.get(f.sha256);
      return b ? [{ path: f.path, content: b.toString('utf8') }] : [];
    }),
    brandWordsFromEnv(env)
  );
  if (!finding.flagged) return { finding, reportId: null };

  const [app] = await db
    .select({ slug: apps.slug, number: appVersions.number })
    .from(apps)
    .innerJoin(appVersions, and(eq(appVersions.appId, apps.id), eq(appVersions.id, versionId)))
    .where(eq(apps.id, appId))
    .limit(1);
  if (!app) return { finding, reportId: null };
  const log = opts.log ?? createConsoleLogger('abuse');
  const [open] = await db
    .select({ id: abuseReports.id })
    .from(abuseReports)
    .where(and(eq(abuseReports.appId, appId), eq(abuseReports.reason, 'heuristic'), eq(abuseReports.status, 'open')))
    .limit(1);
  const logMeta = {
    event: 'abuse_heuristic_flag',
    app_id: appId,
    slug: app.slug,
    version: Number(app.number),
    brands: finding.brands.map((b) => b.word),
    password_in: finding.passwordIn,
  };
  if (open) {
    log.warn('publish heuristic: the app still looks like a phishing page (open report exists)', { ...logMeta, report_id: open.id });
    return { finding, reportId: null };
  }
  let host = app.slug;
  try {
    host = appHostOf({ kind: 'prod', slug: app.slug }, appsOrigin(env).domain);
  } catch {
    // an invalid APPS_DOMAIN is refused at start; keep the slug
  }
  const [row] = await db
    .insert(abuseReports)
    .values({ appId, host, reason: 'heuristic', details: describeFinding(finding, Number(app.number)) })
    .returning({ id: abuseReports.id });
  log.warn('publish heuristic flagged an app for review (not blocked)', { ...logMeta, report_id: row.id });
  return { finding, reportId: row.id };
}

/** `screenPublishedVersion`, but a failure is only logged — a publish never fails because of the scan. */
export async function screenAfterPublish(appId: string, versionId: string, log?: Logger): Promise<ScreenResult | null> {
  try {
    return await screenPublishedVersion(appId, versionId, { log });
  } catch (err) {
    (log ?? createConsoleLogger('abuse')).warn('publish heuristic failed (publish unaffected)', {
      app_id: appId,
      error: String((err as Error)?.message ?? err),
    });
    return null;
  }
}
