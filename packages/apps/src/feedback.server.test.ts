/**
 * Feedback notes on a real (PGlite) database: creating one cleans its
 * context and audits it without the text, the per-account hourly limit and
 * the open-notes cap refuse with the limit's name, lists page newest first
 * per status, resolving and reopening say whether anything changed, and a
 * deleted app takes its notes along.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appFeedback, apps, auditLog, users, workspaces } from '@drobek/db';
import {
  AppsError,
  createApp,
  createFeedback,
  deleteFeedback,
  feedbackCounts,
  getFeedback,
  listFeedback,
  setFeedbackResolved,
  type Actor,
} from './index.js';
import { freshDb, type TestDb } from './test/db.js';

let db: TestDb;
let close: () => Promise<void>;
let ann: Actor & { userId: string };
let bob: Actor & { userId: string };

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const [a] = await db.insert(users).values({ email: 'ann@example.test' }).returning();
  const [b] = await db.insert(users).values({ email: 'bob@example.test' }).returning();
  ann = { userId: a.id, kind: 'user' };
  bob = { userId: b.id, kind: 'user' };
});
afterAll(async () => close());

let n = 0;
async function newApp(): Promise<{ id: string; slug: string; workspaceId: string }> {
  n += 1;
  const [ws] = await db.insert(workspaces).values({ kind: 'team', slug: `fb-${n}`, name: `Feedback ${n}` }).returning();
  const app = await createApp({ workspaceId: ws.id, slug: `feedback-app-${n}`, actor: ann });
  return { ...app, workspaceId: ws.id };
}

const roomy = { maxOpenPerApp: 1000, perUserHour: 1000 };

describe('createFeedback', () => {
  it('stores the cleaned context and audits the note id, never its text', async () => {
    const app = await newApp();
    const note = await createFeedback(
      {
        appId: app.id,
        authorUserId: ann.userId,
        versionNumber: '3',
        path: '/pricing?ref=x#plans',
        anchor: { selector: 'main > h1', x: 10, y: 20, vw: 1280, vh: 800 },
        body: '  The headline overlaps the logo.  ',
      },
      { limits: roomy }
    );
    expect(note).toMatchObject({
      appId: app.id,
      versionNumber: 3,
      path: '/pricing',
      anchor: { selector: 'main > h1', x: 10, y: 20, vw: 1280, vh: 800 },
      body: 'The headline overlaps the logo.',
      authorEmail: 'ann@example.test',
      status: 'open',
      resolvedAt: null,
    });
    expect(note.id).toMatch(/^fb_[0-9a-f]{24}$/);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, 'app.feedback.create'));
    expect(row).toMatchObject({ workspaceId: app.workspaceId, actorUserId: ann.userId, actorKind: 'user', target: app.slug });
    expect(row.meta).toEqual({ appId: app.id, feedback: note.id, version: 3 });
    expect(JSON.stringify(row.meta)).not.toContain('headline');
  });

  it('refuses an empty note', async () => {
    const app = await newApp();
    await expect(createFeedback({ appId: app.id, authorUserId: ann.userId, body: '  ' }, { limits: roomy })).rejects.toMatchObject({
      code: 'invalid_settings',
    });
  });

  it('refuses past FEEDBACK_PER_USER_HOUR with the time to wait, over all apps', async () => {
    const a = await newApp();
    const b = await newApp();
    const limits = { maxOpenPerApp: 100, perUserHour: 2 };
    const t0 = new Date('2026-10-06T10:00:00Z');
    await createFeedback({ appId: a.id, authorUserId: bob.userId, body: 'one' }, { limits, now: t0 });
    await createFeedback({ appId: b.id, authorUserId: bob.userId, body: 'two' }, { limits, now: new Date(t0.getTime() + 60_000) });
    const err = await createFeedback({ appId: a.id, authorUserId: bob.userId, body: 'three' }, { limits, now: new Date(t0.getTime() + 600_000) }).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(AppsError);
    expect(err).toMatchObject({ code: 'rate_limited', details: { limit: 'FEEDBACK_PER_USER_HOUR', value: 2, retry_after_seconds: 3000 } });
    // Another account is not affected; after the hour the author may write again.
    await createFeedback({ appId: a.id, authorUserId: ann.userId, body: 'mine' }, { limits, now: new Date(t0.getTime() + 600_000) });
    await createFeedback({ appId: a.id, authorUserId: bob.userId, body: 'later' }, { limits, now: new Date(t0.getTime() + 3_700_000) });
  });

  it('refuses past FEEDBACK_MAX_OPEN_PER_APP; resolving one makes room', async () => {
    const app = await newApp();
    const limits = { maxOpenPerApp: 2, perUserHour: 100 };
    const first = await createFeedback({ appId: app.id, authorUserId: ann.userId, body: 'a' }, { limits });
    await createFeedback({ appId: app.id, authorUserId: ann.userId, body: 'b' }, { limits });
    await expect(createFeedback({ appId: app.id, authorUserId: ann.userId, body: 'c' }, { limits })).rejects.toMatchObject({
      code: 'limit_exceeded',
      details: { limit: 'FEEDBACK_MAX_OPEN_PER_APP', value: 2 },
    });
    await setFeedbackResolved(app.id, first.id, true, ann);
    await createFeedback({ appId: app.id, authorUserId: ann.userId, body: 'c' }, { limits });
  });
});

describe('listFeedback', () => {
  it('pages newest first per status with before = the last id of the page', async () => {
    const app = await newApp();
    const t0 = Date.parse('2026-10-01T08:00:00Z');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const note = await createFeedback({ appId: app.id, authorUserId: ann.userId, body: `note ${i}` }, { limits: roomy, now: new Date(t0 + i * 1000) });
      ids.push(note.id);
    }
    await setFeedbackResolved(app.id, ids[1], true, ann);
    const p1 = await listFeedback(app.id, { status: 'open', limit: 2 });
    expect(p1.notes.map((x) => x.body)).toEqual(['note 4', 'note 3']);
    expect(p1.nextBefore).toBe(ids[3]);
    const p2 = await listFeedback(app.id, { status: 'open', limit: 2, before: p1.nextBefore });
    expect(p2.notes.map((x) => x.body)).toEqual(['note 2', 'note 0']);
    expect(p2.nextBefore).toBeNull();
    expect((await listFeedback(app.id, { status: 'resolved', limit: 10 })).notes.map((x) => x.body)).toEqual(['note 1']);
    expect((await listFeedback(app.id, { status: 'all', limit: 10 })).notes).toHaveLength(5);
    expect((await feedbackCounts([app.id])).get(app.id)).toEqual({ open: 4, resolved: 1 });
  });

  it('a cursor of another app or a deleted note is not_found', async () => {
    const a = await newApp();
    const b = await newApp();
    const foreign = await createFeedback({ appId: b.id, authorUserId: ann.userId, body: 'x' }, { limits: roomy });
    await expect(listFeedback(a.id, { limit: 5, before: foreign.id })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('setFeedbackResolved / deleteFeedback', () => {
  it('resolves with a note and who did it, reopens clearing that, and reports no change for the same state', async () => {
    const app = await newApp();
    const note = await createFeedback({ appId: app.id, authorUserId: ann.userId, body: 'Typo in the footer' }, { limits: roomy });
    const agent: Actor = { userId: bob.userId, kind: 'agent' };
    const r = await setFeedbackResolved(app.id, note.id, true, agent, { note: 'Fixed in version 5.' });
    expect(r.changed).toBe(true);
    expect(r.note).toMatchObject({
      status: 'resolved',
      resolvedByUserId: bob.userId,
      resolvedByEmail: 'bob@example.test',
      resolvedByKind: 'agent',
      resolutionNote: 'Fixed in version 5.',
    });
    expect(r.note.resolvedAt).toBeInstanceOf(Date);
    expect((await setFeedbackResolved(app.id, note.id, true, agent)).changed).toBe(false);
    const reopened = await setFeedbackResolved(app.id, note.id, false, ann);
    expect(reopened).toMatchObject({ changed: true, note: { status: 'open', resolvedAt: null, resolvedByKind: null, resolutionNote: null } });
    const actions = await db
      .select({ action: auditLog.action, kind: auditLog.actorKind })
      .from(auditLog)
      .where(and(eq(auditLog.target, app.slug)));
    expect(actions.map((a) => `${a.action}:${a.kind}`)).toEqual(
      expect.arrayContaining(['app.feedback.resolve:agent', 'app.feedback.reopen:user'])
    );
  });

  it('a note of another app is not_found; a too long resolution note is refused', async () => {
    const a = await newApp();
    const b = await newApp();
    const note = await createFeedback({ appId: b.id, authorUserId: ann.userId, body: 'x' }, { limits: roomy });
    await expect(setFeedbackResolved(a.id, note.id, true, ann)).rejects.toMatchObject({ code: 'not_found' });
    await expect(setFeedbackResolved(b.id, note.id, true, ann, { note: 'x'.repeat(1001) })).rejects.toMatchObject({ code: 'invalid_settings' });
  });

  it('deletes once and audits; the second time finds nothing', async () => {
    const app = await newApp();
    const note = await createFeedback({ appId: app.id, authorUserId: ann.userId, body: 'x' }, { limits: roomy });
    expect(await deleteFeedback(app.id, note.id, ann)).toBe(true);
    expect(await deleteFeedback(app.id, note.id, ann)).toBe(false);
    expect(await getFeedback(app.id, note.id)).toBeNull();
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, 'app.feedback.delete'));
    expect(rows.some((r) => (r.meta as { feedback?: string }).feedback === note.id)).toBe(true);
  });

  it('the notes go with the app; an author account deleted leaves the note without an author', async () => {
    const app = await newApp();
    const [temp] = await db.insert(users).values({ email: 'temp@example.test' }).returning();
    const note = await createFeedback({ appId: app.id, authorUserId: temp.id, body: 'x' }, { limits: roomy });
    await db.delete(users).where(eq(users.id, temp.id));
    expect(await getFeedback(app.id, note.id)).toMatchObject({ authorUserId: null, authorEmail: null });
    await db.delete(apps).where(eq(apps.id, app.id));
    expect(await db.select().from(appFeedback).where(eq(appFeedback.appId, app.id))).toEqual([]);
  });
});
