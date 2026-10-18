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
 * A note may carry one screenshot: the uploaded image is re-encoded
 * (image.server.ts — never stored as uploaded) into a WebP in `blobs`, keyed
 * by its sha256 like version files; the note keeps the sha256, dimensions and
 * size. FEEDBACK_SCREENSHOTS_MAX_PER_APP caps the notes with a screenshot per
 * app (`limit_exceeded`, counted under the app's row lock). Deleting a note
 * releases its screenshot, and so does the hourly job once a note has been
 * resolved for FEEDBACK_SCREENSHOT_RETENTION_DAYS (the note stays); the blob
 * GC then frees the bytes nothing else references.
 *
 * Lists page newest first (created_at, id) with `before` = the id of the last
 * note of the previous page.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, count, desc, eq, gte, inArray, isNotNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AUDIT_ACTIONS, writeAudit } from '@drobek/audit';
import { appFeedback, blobs, getDb, users } from '@drobek/db';
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
import { imageLimits, reencodeScreenshot, type EncodedImage, type ImageLimits } from './image.server.js';
import { lockApp } from './versions.server.js';
import type { Actor } from './types.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A note's screenshot as the lists show it (the bytes are read on their own, getFeedbackScreenshot). */
export interface FeedbackScreenshotInfo {
  sha256: string;
  width: number;
  height: number;
  bytes: number;
}

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
  /** The attached screenshot (re-encoded WebP), or null. */
  screenshot: FeedbackScreenshotInfo | null;
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
      screenshotSha256: appFeedback.screenshotSha256,
      screenshotWidth: appFeedback.screenshotWidth,
      screenshotHeight: appFeedback.screenshotHeight,
      screenshotBytes: appFeedback.screenshotBytes,
    })
    .from(appFeedback)
    .leftJoin(users, eq(users.id, appFeedback.authorUserId))
    .leftJoin(resolver, eq(resolver.id, appFeedback.resolvedByUserId));
}

type NoteRow = Awaited<ReturnType<ReturnType<typeof selectNotes>['where']>>[number];

function noteOf({ screenshotSha256, screenshotWidth, screenshotHeight, screenshotBytes, ...r }: NoteRow): FeedbackNote {
  return {
    ...r,
    screenshot:
      screenshotSha256 && screenshotWidth && screenshotHeight && screenshotBytes
        ? { sha256: screenshotSha256, width: screenshotWidth, height: screenshotHeight, bytes: screenshotBytes }
        : null,
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
  /** The uploaded screenshot as sent (PNG, JPEG or WebP, at most SCREENSHOT_MAX_BYTES); it is re-encoded, never stored as is. */
  screenshot?: Uint8Array | null;
}

/**
 * Store a note. Refuses `invalid_settings` for an empty or too long body,
 * `too_large` for a screenshot over SCREENSHOT_MAX_BYTES, `invalid_image` for
 * one that is not a PNG, JPEG or WebP that decodes, `rate_limited` past
 * FEEDBACK_PER_USER_HOUR, `limit_exceeded` past FEEDBACK_MAX_OPEN_PER_APP or
 * FEEDBACK_SCREENSHOTS_MAX_PER_APP and `not_found` for an app that is gone.
 * Audited `app.feedback.create` (the note id, the version and whether it has
 * a screenshot — never the text or the image).
 */
export async function createFeedback(
  input: CreateFeedbackInput,
  opts: { limits?: FeedbackLimits; imageLimits?: ImageLimits; now?: Date } = {}
): Promise<FeedbackNote> {
  const body = validateFeedbackBody(input.body);
  if (!body.ok) throw new AppsError('invalid_settings', body.message);
  const limits = opts.limits ?? feedbackLimits();
  const now = opts.now ?? new Date();
  const id = newFeedbackId();
  let shot: (EncodedImage & { sha256: string }) | null = null;
  if (input.screenshot && input.screenshot.byteLength > 0) {
    const imgLimits = opts.imageLimits ?? imageLimits();
    if (input.screenshot.byteLength > imgLimits.screenshotMaxBytes) {
      throw new AppsError(
        'too_large',
        `The screenshot is ${mibText(input.screenshot.byteLength)}; a note takes one of at most ${mibText(imgLimits.screenshotMaxBytes)} (SCREENSHOT_MAX_BYTES). Take a smaller one, or crop it.`,
        { details: { limit: 'SCREENSHOT_MAX_BYTES', value: imgLimits.screenshotMaxBytes } }
      );
    }
    const encoded = await reencodeScreenshot(input.screenshot, imgLimits);
    shot = { ...encoded, sha256: createHash('sha256').update(encoded.bytes).digest('hex') };
  }
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
    if (shot) {
      const [withShot] = await tx
        .select({ n: count() })
        .from(appFeedback)
        .where(and(eq(appFeedback.appId, input.appId), isNotNull(appFeedback.screenshotSha256)));
      if (Number(withShot?.n ?? 0) >= limits.screenshotsMaxPerApp) {
        throw new AppsError(
          'limit_exceeded',
          `This app already holds ${limits.screenshotsMaxPerApp} notes with a screenshot, the most it may (FEEDBACK_SCREENSHOTS_MAX_PER_APP). Send this note without the screenshot, or delete notes that are done — a resolved note drops its screenshot ${limits.screenshotRetentionDays} days after it was resolved.`,
          { details: { limit: 'FEEDBACK_SCREENSHOTS_MAX_PER_APP', value: limits.screenshotsMaxPerApp } }
        );
      }
      await tx
        .insert(blobs)
        .values({ sha256: shot.sha256, bytes: shot.bytes, size: shot.bytes.length })
        .onConflictDoUpdate({ target: blobs.sha256, set: { createdAt: sql`now()` } });
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
      ...(shot
        ? { screenshotSha256: shot.sha256, screenshotWidth: shot.width, screenshotHeight: shot.height, screenshotBytes: shot.bytes.length }
        : {}),
    });
    await writeAudit(
      {
        workspaceId: app.workspaceId,
        actorUserId: input.authorUserId,
        actorKind: 'user',
        action: AUDIT_ACTIONS.appFeedbackCreate,
        subjectType: 'app',
        target: app.slug,
        meta: {
          appId: input.appId,
          feedback: id,
          ...(versionNumber !== null ? { version: versionNumber } : {}),
          ...(input.anchor?.label ? { label: input.anchor.label } : {}),
          ...(shot ? { screenshot: true } : {}),
        },
      },
      tx
    );
  });
  return (await getFeedback(input.appId, id))!;
}

function mibText(bytes: number): string {
  const v = bytes / (1024 * 1024);
  return v >= 1 ? `${Number.isInteger(v) ? v : v.toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
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

export interface FeedbackScreenshot extends FeedbackScreenshotInfo {
  /** The stored WebP. */
  data: Buffer;
  mimeType: 'image/webp';
}

/** The screenshot of one note of the app, or null when the app has no such note or the note has none. */
export async function getFeedbackScreenshot(appId: string, id: string): Promise<FeedbackScreenshot | null> {
  const [row] = await getDb()
    .select({
      sha256: appFeedback.screenshotSha256,
      width: appFeedback.screenshotWidth,
      height: appFeedback.screenshotHeight,
      data: blobs.bytes,
    })
    .from(appFeedback)
    .innerJoin(blobs, eq(blobs.sha256, appFeedback.screenshotSha256))
    .where(and(eq(appFeedback.appId, appId), eq(appFeedback.id, id)))
    .limit(1);
  if (!row?.sha256 || !row.width || !row.height) return null;
  const data = Buffer.from(row.data);
  return { sha256: row.sha256, width: row.width, height: row.height, bytes: data.length, data, mimeType: 'image/webp' };
}

/**
 * Drop the screenshots of notes resolved more than
 * FEEDBACK_SCREENSHOT_RETENTION_DAYS ago (the notes stay); the blob GC frees
 * the bytes. Returns how many notes lost theirs.
 */
export async function pruneResolvedFeedbackScreenshots(opts: { retentionDays?: number; now?: Date } = {}): Promise<number> {
  const days = opts.retentionDays ?? feedbackLimits().screenshotRetentionDays;
  const cutoff = new Date((opts.now ?? new Date()).getTime() - days * DAY_MS);
  const rows = await getDb()
    .update(appFeedback)
    .set({ screenshotSha256: null, screenshotWidth: null, screenshotHeight: null, screenshotBytes: null })
    .where(and(eq(appFeedback.status, 'resolved'), lt(appFeedback.resolvedAt, cutoff), isNotNull(appFeedback.screenshotSha256)))
    .returning({ id: appFeedback.id });
  return rows.length;
}
