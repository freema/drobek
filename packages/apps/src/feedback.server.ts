/**
 * Feedback on the app preview — the stored notes (`app_feedback`).
 *
 * A note is created only through the dashboard (a signed-in member of the
 * app's workspace, any role; the caller checks the membership) and is
 * resolved, reopened or deleted from the dashboard or by the member's agent
 * over MCP; each change writes its audit row. Two limits guard the table:
 * FEEDBACK_PER_USER_HOUR notes per account within the last hour
 * (`rate_limited` with `retry_after_seconds`) and FEEDBACK_MAX_OPEN_PER_APP
 * open notes per app (`limit_exceeded`); both are counted from the table under
 * the app's row lock and a per-account advisory lock, so concurrent notes
 * (on one app or on several) cannot pass them.
 *
 * Lists page newest first (created_at, id) with `before` = the id of the last
 * note of the previous page.
 */
import { randomBytes } from 'node:crypto';
import { and, count, desc, eq, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AUDIT_ACTIONS, writeAudit } from '@drobek/audit';
import { appFeedback, getDb, users } from '@drobek/db';
import { AppsError } from './errors.js';
import {
  feedbackLimits,
  feedbackVersionNumber,
  normalizeFeedbackPath,
  storedFeedbackAnchor,
  validateFeedbackBody,
  validateResolutionNote,
  type FeedbackAnchor,
  type FeedbackLimits,
  type FeedbackStatus,
} from './feedback.js';
import { lockApp } from './versions.server.js';
import type { Actor } from './types.js';

const HOUR_MS = 60 * 60 * 1000;

export interface FeedbackNote {
  id: string;
  appId: string;
  versionNumber: number | null;
  path: string;
  anchor: FeedbackAnchor | null;
  body: string;
  authorUserId: string | null;
  /** The author's sign-in e-mail (null once the account is gone). */
  authorEmail: string | null;
  status: FeedbackStatus;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedByUserId: string | null;
  resolvedByEmail: string | null;
  /** `user` = resolved in the dashboard, `agent` = by an agent over MCP. */
  resolvedByKind: 'user' | 'agent' | null;
  resolutionNote: string | null;
}

function newFeedbackId(): string {
  return `fb_${randomBytes(12).toString('hex')}`;
}

const resolver = alias(users, 'feedback_resolver');

function selectNotes(ex: Pick<ReturnType<typeof getDb>, 'select'>) {
  return ex
    .select({
      id: appFeedback.id,
      appId: appFeedback.appId,
      versionNumber: appFeedback.versionNumber,
      path: appFeedback.path,
      anchor: appFeedback.anchor,
      body: appFeedback.body,
      authorUserId: appFeedback.authorUserId,
      authorEmail: users.email,
      status: appFeedback.status,
      createdAt: appFeedback.createdAt,
      resolvedAt: appFeedback.resolvedAt,
      resolvedByUserId: appFeedback.resolvedByUserId,
      resolvedByEmail: resolver.email,
      resolvedByKind: appFeedback.resolvedByKind,
      resolutionNote: appFeedback.resolutionNote,
    })
    .from(appFeedback)
    .leftJoin(users, eq(users.id, appFeedback.authorUserId))
    .leftJoin(resolver, eq(resolver.id, appFeedback.resolvedByUserId));
}

type NoteRow = Awaited<ReturnType<ReturnType<typeof selectNotes>['where']>>[number];

function noteOf(r: NoteRow): FeedbackNote {
  return {
    ...r,
    anchor: storedFeedbackAnchor(r.anchor),
    authorEmail: r.authorEmail ?? null,
    resolvedByEmail: r.resolvedByEmail ?? null,
    resolvedByKind: r.resolvedByKind === 'user' || r.resolvedByKind === 'agent' ? r.resolvedByKind : null,
  };
}

export interface CreateFeedbackInput {
  appId: string;
  authorUserId: string;
  /** The values the widget passed along; cleaned here (see feedback.ts). */
  versionNumber?: unknown;
  path?: unknown;
  anchor?: FeedbackAnchor | null;
  body: unknown;
}

/**
 * Store a note. Refuses `invalid_settings` for an empty or too long body,
 * `rate_limited` past FEEDBACK_PER_USER_HOUR, `limit_exceeded` past
 * FEEDBACK_MAX_OPEN_PER_APP and `not_found` for an app that is gone.
 * Audited `app.feedback.create` (the note id and version, never the text).
 */
export async function createFeedback(input: CreateFeedbackInput, opts: { limits?: FeedbackLimits; now?: Date } = {}): Promise<FeedbackNote> {
  const body = validateFeedbackBody(input.body);
  if (!body.ok) throw new AppsError('invalid_settings', body.message);
  const limits = opts.limits ?? feedbackLimits();
  const now = opts.now ?? new Date();
  const id = newFeedbackId();
  await getDb().transaction(async (tx) => {
    const app = await lockApp(tx, input.appId);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`drobek:feedback:${input.authorUserId}`}::text))`);
    const since = new Date(now.getTime() - HOUR_MS);
    const recent = await tx
      .select({ createdAt: appFeedback.createdAt })
      .from(appFeedback)
      .where(and(eq(appFeedback.authorUserId, input.authorUserId), gte(appFeedback.createdAt, since)))
      .orderBy(appFeedback.createdAt)
      .limit(limits.perUserHour);
    if (recent.length >= limits.perUserHour) {
      const retry = Math.max(1, Math.ceil((recent[0].createdAt.getTime() + HOUR_MS - now.getTime()) / 1000));
      throw new AppsError(
        'rate_limited',
        `You left ${limits.perUserHour} notes within the last hour, the most one account may (FEEDBACK_PER_USER_HOUR). Try again in ${Math.ceil(retry / 60)} minutes.`,
        { details: { limit: 'FEEDBACK_PER_USER_HOUR', value: limits.perUserHour, retry_after_seconds: retry } }
      );
    }
    const [open] = await tx
      .select({ n: count() })
      .from(appFeedback)
      .where(and(eq(appFeedback.appId, input.appId), eq(appFeedback.status, 'open')));
    if (Number(open?.n ?? 0) >= limits.maxOpenPerApp) {
      throw new AppsError(
        'limit_exceeded',
        `This app already has ${limits.maxOpenPerApp} open notes, the most it may hold (FEEDBACK_MAX_OPEN_PER_APP). Resolve or delete notes that are done, then send this one again.`,
        { details: { limit: 'FEEDBACK_MAX_OPEN_PER_APP', value: limits.maxOpenPerApp } }
      );
    }
    const versionNumber = feedbackVersionNumber(input.versionNumber);
    await tx.insert(appFeedback).values({
      id,
      appId: input.appId,
      versionNumber,
      path: normalizeFeedbackPath(input.path),
      anchor: input.anchor ?? null,
      body: body.body,
      authorUserId: input.authorUserId,
      createdAt: now,
    });
    await writeAudit(
      {
        workspaceId: app.workspaceId,
        actorUserId: input.authorUserId,
        actorKind: 'user',
        action: AUDIT_ACTIONS.appFeedbackCreate,
        subjectType: 'app',
        target: app.slug,
        meta: { appId: input.appId, feedback: id, ...(versionNumber !== null ? { version: versionNumber } : {}) },
      },
      tx
    );
  });
  return (await getFeedback(input.appId, id))!;
}

/** One note of the app, or null. */
export async function getFeedback(appId: string, id: string): Promise<FeedbackNote | null> {
  const [row] = await selectNotes(getDb()).where(and(eq(appFeedback.appId, appId), eq(appFeedback.id, id))).limit(1);
  return row ? noteOf(row) : null;
}

export interface ListFeedbackOptions {
  status?: FeedbackStatus | 'all';
  /** The id of the last note of the previous page. */
  before?: string | null;
  limit: number;
}

export interface FeedbackPage {
  notes: FeedbackNote[];
  /** The `before` of the next, older page; null = this was the last page. */
  nextBefore: string | null;
}

/**
 * One page of the app's notes, newest first. A `before` that is not a note of
 * this app refuses `not_found` (a stale or foreign cursor).
 */
export async function listFeedback(appId: string, opts: ListFeedbackOptions): Promise<FeedbackPage> {
  const db = getDb();
  const where: SQL[] = [eq(appFeedback.appId, appId)];
  if (opts.status && opts.status !== 'all') where.push(eq(appFeedback.status, opts.status));
  if (opts.before) {
    const [cursor] = await db
      .select({ createdAt: appFeedback.createdAt })
      .from(appFeedback)
      .where(and(eq(appFeedback.appId, appId), eq(appFeedback.id, opts.before)))
      .limit(1);
    if (!cursor) throw new AppsError('not_found', 'That page no longer exists: the note it continued from was deleted. Start from the newest notes.');
    where.push(
      or(lt(appFeedback.createdAt, cursor.createdAt), and(eq(appFeedback.createdAt, cursor.createdAt), lt(appFeedback.id, opts.before)))!
    );
  }
  const rows = await selectNotes(db)
    .where(and(...where))
    .orderBy(desc(appFeedback.createdAt), desc(appFeedback.id))
    .limit(opts.limit + 1);
  const notes = rows.slice(0, opts.limit).map(noteOf);
  return { notes, nextBefore: rows.length > opts.limit ? notes[notes.length - 1].id : null };
}

/** Open and resolved notes per app (absent apps have none). */
export async function feedbackCounts(appIds: readonly string[]): Promise<Map<string, { open: number; resolved: number }>> {
  const out = new Map<string, { open: number; resolved: number }>();
  if (appIds.length === 0) return out;
  const rows = await getDb()
    .select({ appId: appFeedback.appId, status: appFeedback.status, n: count() })
    .from(appFeedback)
    .where(inArray(appFeedback.appId, [...new Set(appIds)]))
    .groupBy(appFeedback.appId, appFeedback.status);
  for (const r of rows) {
    const c = out.get(r.appId) ?? { open: 0, resolved: 0 };
    c[r.status] = Number(r.n);
    out.set(r.appId, c);
  }
  return out;
}

export interface SetFeedbackResolvedResult {
  note: FeedbackNote;
  /** False when the note already had that status (nothing changed, nothing audited). */
  changed: boolean;
}

/**
 * Resolve (`resolved: true`, with an optional resolution note) or reopen a
 * note. `not_found` for a note the app does not have; `invalid_settings` for a
 * resolution note past FEEDBACK_RESOLUTION_NOTE_MAX. Audited
 * `app.feedback.resolve` / `app.feedback.reopen`.
 */
export async function setFeedbackResolved(
  appId: string,
  id: string,
  resolved: boolean,
  actor: Actor,
  opts: { note?: unknown; now?: Date } = {}
): Promise<SetFeedbackResolvedResult> {
  const note = validateResolutionNote(opts.note);
  if (!note.ok) throw new AppsError('invalid_settings', note.message);
  const changed = await getDb().transaction(async (tx) => {
    const app = await lockApp(tx, appId);
    const [row] = await tx
      .select({ status: appFeedback.status })
      .from(appFeedback)
      .where(and(eq(appFeedback.appId, appId), eq(appFeedback.id, id)))
      .for('update');
    if (!row) throw new AppsError('not_found', 'This app has no such feedback note: it was deleted, or the id is wrong.');
    if ((row.status === 'resolved') === resolved) return false;
    await tx
      .update(appFeedback)
      .set(
        resolved
          ? {
              status: 'resolved',
              resolvedAt: opts.now ?? new Date(),
              resolvedByUserId: actor.userId,
              resolvedByKind: actor.kind === 'agent' ? 'agent' : 'user',
              resolutionNote: note.note,
            }
          : { status: 'open', resolvedAt: null, resolvedByUserId: null, resolvedByKind: null, resolutionNote: null }
      )
      .where(eq(appFeedback.id, id));
    await writeAudit(
      {
        workspaceId: app.workspaceId,
        actorUserId: actor.userId,
        actorKind: actor.kind,
        action: resolved ? AUDIT_ACTIONS.appFeedbackResolve : AUDIT_ACTIONS.appFeedbackReopen,
        subjectType: 'app',
        target: app.slug,
        meta: { appId, feedback: id },
      },
      tx
    );
    return true;
  });
  return { note: (await getFeedback(appId, id))!, changed };
}

/** Delete a note for good (the caller checked mayDeleteFeedback). False when it was not there. Audited `app.feedback.delete`. */
export async function deleteFeedback(appId: string, id: string, actor: Actor): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const app = await lockApp(tx, appId);
    const gone = await tx
      .delete(appFeedback)
      .where(and(eq(appFeedback.appId, appId), eq(appFeedback.id, id)))
      .returning({ id: appFeedback.id });
    if (gone.length === 0) return false;
    await writeAudit(
      {
        workspaceId: app.workspaceId,
        actorUserId: actor.userId,
        actorKind: actor.kind,
        action: AUDIT_ACTIONS.appFeedbackDelete,
        subjectType: 'app',
        target: app.slug,
        meta: { appId, feedback: id },
      },
      tx
    );
    return true;
  });
}
