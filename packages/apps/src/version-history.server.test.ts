/**
 * The version history on a real (PGlite) database: paging through the
 * history, the pinned set (published, preview, kept), keeping a version under
 * APP_VERSIONS_KEPT_MAX, and a member's clean-up — which leaves the same
 * versions alone as the retention, says why, audits and never lets a number
 * be reused.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appVersions, apps, auditLog, users, workspaces } from '@drobek/db';
import {
  AppsError,
  createApp,
  createVersion,
  deleteVersions,
  keepVersion,
  listVersions,
  missingVersionMessage,
  pinnedVersions,
  planVersionDeletion,
  pruneVersionHistory,
  publish,
  versionRanges,
  workspaceSourceBytes,
  type Actor,
} from './index.js';
import { freshDb, type TestDb } from './test/db.js';

let db: TestDb;
let close: () => Promise<void>;
let ann: Actor;

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const [a] = await db.insert(users).values({ email: 'ann@example.test' }).returning();
  ann = { userId: a.id, kind: 'user' };
});
afterAll(async () => close());

let n = 0;
async function newApp(): Promise<{ id: string; slug: string; workspaceId: string }> {
  n += 1;
  const [ws] = await db.insert(workspaces).values({ kind: 'team', slug: `hist-${n}`, name: `History ${n}` }).returning();
  const app = await createApp({ workspaceId: ws.id, slug: `history-app-${n}`, actor: ann });
  return { ...app, workspaceId: ws.id };
}

const unlimited = { perApp: 100_000, perUser: 100_000 };

function write(appId: string, content: string, ok = true) {
  return createVersion(appId, [{ path: 'index.html', content }], {
    actor: ann,
    versionLimits: unlimited,
    compile: { status: ok ? 'ok' : 'error' },
  });
}

async function writeMany(appId: string, count: number, ok = true): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push((await write(appId, `<p>${appId} ${Math.random()}</p>`, ok)).id);
  return ids;
}

async function ageVersions(appId: string): Promise<void> {
  await db
    .update(appVersions)
    .set({ createdAt: sql`${appVersions.createdAt} - make_interval(mins => 90)` })
    .where(eq(appVersions.appId, appId));
}

async function numbers(appId: string): Promise<number[]> {
  const rows = await db.select({ n: appVersions.number }).from(appVersions).where(eq(appVersions.appId, appId)).orderBy(appVersions.number);
  return rows.map((r) => r.n);
}

async function auditOf(workspaceId: string, action: string) {
  return db
    .select({ actor: auditLog.actorUserId, actorKind: auditLog.actorKind, target: auditLog.target, meta: auditLog.meta })
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.action, action)))
    .orderBy(auditLog.createdAt);
}

async function refusal(p: Promise<unknown>): Promise<AppsError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(AppsError);
  return err as AppsError;
}

describe('versionRanges', () => {
  it('compresses version numbers into ranges', () => {
    expect(versionRanges([])).toEqual([]);
    expect(versionRanges([5])).toEqual(['5']);
    expect(versionRanges([9, 3, 4, 5, 41, 40, 4])).toEqual(['3-5', '9', '40-41']);
  });
});

describe('listVersions', () => {
  it('pages newest first by number with a cursor, to the end of the list', async () => {
    const app = await newApp();
    await writeMany(app.id, 7);
    const p1 = await listVersions(app.id, { limit: 3 });
    expect(p1.versions.map((v) => v.number)).toEqual([7, 6, 5]);
    expect(p1.nextBefore).toBe(5);
    const p2 = await listVersions(app.id, { limit: 3, before: p1.nextBefore! });
    expect(p2.versions.map((v) => v.number)).toEqual([4, 3, 2]);
    expect(p2.nextBefore).toBe(2);
    const p3 = await listVersions(app.id, { limit: 3, before: p2.nextBefore! });
    expect(p3).toMatchObject({ nextBefore: null });
    expect(p3.versions.map((v) => v.number)).toEqual([1]);

    // A page that ends exactly at the oldest version has no next page.
    expect((await listVersions(app.id, { limit: 7 })).nextBefore).toBeNull();
    expect((await listVersions(app.id, { limit: 3, before: 4 })).nextBefore).toBeNull();
    // A cursor at or past the oldest version is an empty last page.
    expect(await listVersions(app.id, { limit: 3, before: 1 })).toEqual({ versions: [], nextBefore: null });
    expect(await listVersions(app.id, { limit: 3, before: -5 })).toEqual({ versions: [], nextBefore: null });
    // The default page is 50.
    expect((await listVersions(app.id)).versions).toHaveLength(7);
    // A limit or cursor that is not a number falls back to the default page from the newest.
    expect((await listVersions(app.id, { limit: Number.NaN, before: Number.NaN })).versions).toHaveLength(7);
    expect((await listVersions(app.id, { limit: 2, before: Number.POSITIVE_INFINITY })).versions.map((v) => v.number)).toEqual([7, 6]);
    expect((await listVersions(app.id, { limit: 2, before: 4.5 })).versions.map((v) => v.number)).toEqual([4, 3]);
  });

  it('flags the published, preview and kept versions', async () => {
    const app = await newApp();
    const [v1] = await writeMany(app.id, 2);
    await write(app.id, '<p>broken', false);
    await publish(app.id, v1, ann, { screen: false });
    await keepVersion(app.id, 3, true, ann, { keptMax: 5 });
    const { versions } = await listVersions(app.id);
    expect(versions.map((v) => ({ n: v.number, published: v.published, preview: v.preview, kept: v.kept }))).toEqual([
      { n: 3, published: false, preview: false, kept: true },
      { n: 2, published: false, preview: true, kept: false },
      { n: 1, published: true, preview: false, kept: false },
    ]);
    expect(versions[0].keptAt).toBeInstanceOf(Date);
    expect(versions[0].keptByUserId).toBe(ann.userId);
    expect(versions[1].keptAt).toBeNull();
  });
});

describe('pinnedVersions', () => {
  it('lists the published, preview and kept versions once each, newest first, however old', async () => {
    const app = await newApp();
    const ids = await writeMany(app.id, 30);
    await write(app.id, '<p>broken', false);
    await publish(app.id, ids[0], ann, { screen: false });
    await keepVersion(app.id, 12, true, ann, { keptMax: 5 });
    await keepVersion(app.id, 31, true, ann, { keptMax: 5 });
    const pinned = await pinnedVersions(app.id);
    expect(pinned.map((v) => [v.number, v.published, v.preview, v.kept])).toEqual([
      [31, false, false, true],
      [30, false, true, false],
      [12, false, false, true],
      [1, true, false, false],
    ]);
  });

  it('shows a version that is both published and the preview once', async () => {
    const app = await newApp();
    const [, v2] = await writeMany(app.id, 2);
    await publish(app.id, v2, ann, { screen: false });
    const pinned = await pinnedVersions(app.id);
    expect(pinned.map((v) => [v.number, v.published, v.preview, v.kept])).toEqual([[2, true, true, false]]);
    expect(await pinnedVersions((await newApp()).id)).toEqual([]);
  });
});

describe('keepVersion (APP_VERSIONS_KEPT_MAX)', () => {
  it('keeps up to the cap, refuses past it, honours a plan cap and leaves kept versions alone under a lowered cap', async () => {
    const app = await newApp();
    await writeMany(app.id, 5);
    const first = await keepVersion(app.id, 1, true, ann, { keptMax: 2 });
    expect(first).toMatchObject({ number: 1, kept: true, changed: true, prunable: false });
    expect(first.keptAt).toBeInstanceOf(Date);
    await keepVersion(app.id, 2, true, ann, { keptMax: 2 });

    const err = await refusal(keepVersion(app.id, 3, true, ann, { keptMax: 2 }));
    expect(err.code).toBe('limit_exceeded');
    expect(err.details).toEqual({ limit: 'APP_VERSIONS_KEPT_MAX', value: 2 });
    expect(err.message).toContain('Stop keeping a version');

    // A plan with a higher cap allows it.
    expect(await keepVersion(app.id, 3, true, ann, { keptMax: 3 })).toMatchObject({ changed: true });
    // A lowered cap keeps what is kept and only refuses more.
    expect((await refusal(keepVersion(app.id, 4, true, ann, { keptMax: 1 }))).code).toBe('limit_exceeded');
    expect((await pinnedVersions(app.id)).filter((v) => v.kept).map((v) => v.number)).toEqual([3, 2, 1]);
    expect(await keepVersion(app.id, 3, false, ann, { keptMax: 1 })).toMatchObject({ kept: false, keptAt: null, changed: true });
  });

  it('answers changed:false for the same state, not_found for an unknown version; audits keep and unkeep', async () => {
    const app = await newApp();
    await writeMany(app.id, 2);
    await keepVersion(app.id, 1, true, ann, { keptMax: 5 });
    const again = await keepVersion(app.id, 1, true, ann, { keptMax: 5 });
    expect(again).toMatchObject({ kept: true, changed: false });
    expect(again.keptAt).toBeInstanceOf(Date);
    expect(await keepVersion(app.id, 2, false, ann, { keptMax: 5 })).toMatchObject({ kept: false, changed: false });

    const missing = await refusal(keepVersion(app.id, 9, true, ann, { keptMax: 5 }));
    expect(missing.code).toBe('not_found');
    expect(missing.message).toBe('Version 9 does not exist — the newest version is 2.');

    await keepVersion(app.id, 1, false, ann, { keptMax: 5 });
    expect(await auditOf(app.workspaceId, 'app.version.keep')).toEqual([
      { actor: ann.userId, actorKind: 'user', target: app.slug, meta: { appId: app.id, version: 1 } },
    ]);
    expect(await auditOf(app.workspaceId, 'app.version.unkeep')).toEqual([
      { actor: ann.userId, actorKind: 'user', target: app.slug, meta: { appId: app.id, version: 1 } },
    ]);
  });

  it('works on a taken-down app and on a failed build; unkeeping outside the newest APP_VERSIONS_KEEP says it is prunable', async () => {
    const app = await newApp();
    await write(app.id, '<p>broken', false);
    await writeMany(app.id, 4);
    await db.update(apps).set({ lockedReason: 'spam' }).where(eq(apps.id, app.id));
    expect(await keepVersion(app.id, 1, true, ann, { keptMax: 5 })).toMatchObject({ kept: true, changed: true });
    await keepVersion(app.id, 2, true, ann, { keptMax: 5 });
    await keepVersion(app.id, 4, true, ann, { keptMax: 5 });

    expect(await keepVersion(app.id, 1, false, ann, { keptMax: 5, keep: 2 })).toMatchObject({ prunable: true });
    // Inside the newest `keep` versions: the retention leaves it alone.
    expect(await keepVersion(app.id, 4, false, ann, { keptMax: 5, keep: 2 })).toMatchObject({ prunable: false });
    expect(await keepVersion(app.id, 2, false, ann, { keptMax: 5, keep: 200 })).toMatchObject({ prunable: false });
  });
});

describe('the retention and kept versions', () => {
  it('never deletes a kept version', async () => {
    const app = await newApp();
    await writeMany(app.id, 6);
    await keepVersion(app.id, 2, true, ann, { keptMax: 5 });
    await ageVersions(app.id);
    await pruneVersionHistory({ limits: async (ws) => (ws === app.workspaceId ? { APP_VERSIONS_KEEP: 2 } : null) });
    expect(await numbers(app.id)).toEqual([2, 5, 6]);
  });
});

describe('planVersionDeletion / deleteVersions', () => {
  /**
   * v1 kept, v2 a rollback set, v3 free, v4 published, v5 a free failed
   * build, v6 the preview, v7 a free failed build, v8 from the last hour,
   * v9 the newest.
   */
  async function everyReason() {
    const app = await newApp();
    const ids = await writeMany(app.id, 4);
    await write(app.id, '<p>broken 5', false);
    await write(app.id, '<p>ok 6</p>');
    await write(app.id, '<p>broken 7', false);
    await publish(app.id, ids[1], ann, { screen: false });
    await publish(app.id, ids[3], ann, { screen: false });
    await keepVersion(app.id, 1, true, ann, { keptMax: 5 });
    await ageVersions(app.id);
    await write(app.id, '<p>broken 8', false);
    await write(app.id, '<p>broken 9', false);
    return app;
  }

  const SKIPPED = { kept: ['1'], rollback_assets: ['2'], published: ['4'], preview: ['6'], recent: ['8'], newest: ['9'] };

  it('plans and deletes all but the protected versions, saying why each stays; audits; frees the quota', async () => {
    const app = await everyReason();
    const plan = await planVersionDeletion(app.id, 9);
    expect(plan).toEqual({ deleted: ['3', '5', '7'], count: 3, skipped: SKIPPED, planId: expect.stringMatching(/^[0-9a-f]{24}$/) });
    expect(await numbers(app.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const before = await workspaceSourceBytes(app.workspaceId);
    expect(await deleteVersions(app.id, 9, {}, ann)).toEqual(plan);
    expect(await numbers(app.id)).toEqual([1, 2, 4, 6, 8, 9]);
    expect(await workspaceSourceBytes(app.workspaceId)).toBeLessThan(before);
    expect(await auditOf(app.workspaceId, 'app.versions.delete')).toEqual([
      { actor: ann.userId, actorKind: 'user', target: app.slug, meta: { appId: app.id, count: 3, from: 3, to: 7, failedOnly: false } },
    ]);

    // Nothing left to delete; no audit row for an empty clean-up.
    expect(await deleteVersions(app.id, 9, {}, ann)).toMatchObject({ deleted: [], count: 0 });
    expect(await auditOf(app.workspaceId, 'app.versions.delete')).toHaveLength(1);
    // The next write still gets a fresh number.
    expect((await write(app.id, '<p>10</p>')).number).toBe(10);
    // A deleted version answers not_found naming both deleters and the kept versions.
    expect(await missingVersionMessage(app.id, 3)).toBe(
      "Version 3 is no longer stored: the history retention or a member's clean-up deleted it. An app keeps its newest versions, the published one, the kept ones and those kept for a rollback; the oldest version still stored is 1."
    );
  });

  it('stops at `upTo` and with failedOnly deletes only failed builds', async () => {
    const app = await everyReason();
    expect(await planVersionDeletion(app.id, 4)).toEqual({
      deleted: ['3'],
      count: 1,
      skipped: { kept: ['1'], rollback_assets: ['2'], published: ['4'] },
      planId: expect.any(String),
    });
    expect(await planVersionDeletion(app.id, 0)).toMatchObject({ deleted: [], count: 0, skipped: {} });
    const out = await deleteVersions(app.id, 9, { failedOnly: true }, ann);
    expect(out).toMatchObject({ deleted: ['5', '7'], count: 2, skipped: { recent: ['8'], newest: ['9'] } });
    expect(await numbers(app.id)).toEqual([1, 2, 3, 4, 6, 8, 9]);
    expect((await auditOf(app.workspaceId, 'app.versions.delete'))[0].meta).toEqual({ appId: app.id, count: 2, from: 5, to: 7, failedOnly: true });
  });

  it('keeps the newest version even when nothing else protects it, so numbers are never reused', async () => {
    const app = await newApp();
    await write(app.id, '<p>ok</p>');
    await write(app.id, '<p>broken', false);
    await ageVersions(app.id);
    expect(await deleteVersions(app.id, 2, {}, ann)).toMatchObject({ deleted: [], count: 0, skipped: { preview: ['1'], newest: ['2'] } });
    expect((await write(app.id, '<p>3</p>')).number).toBe(3);
  });

  it('deletes in batches, one audit row per batch', async () => {
    const app = await newApp();
    await db.insert(appVersions).values(
      Array.from({ length: 205 }, (_, i) => ({
        appId: app.id,
        number: i + 1,
        actorKind: 'agent' as const,
        compileStatus: 'error' as const,
        createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      }))
    );
    const out = await deleteVersions(app.id, 205, {}, ann);
    expect(out).toMatchObject({ deleted: ['1-204'], count: 204, skipped: { newest: ['205'] } });
    expect(await numbers(app.id)).toEqual([205]);
    const rows = await auditOf(app.workspaceId, 'app.versions.delete');
    expect(rows.map((r) => (r.meta as { count: number }).count).sort((a, b) => a - b)).toEqual([4, 200]);
  });

  it('with expectedPlanId deletes exactly the confirmed plan, and nothing once the plan changed', async () => {
    const app = await everyReason();
    const plan = await planVersionDeletion(app.id, 9);
    // The same set from another scope has the same id.
    expect((await planVersionDeletion(app.id, 7)).planId).toBe(plan.planId);
    expect((await planVersionDeletion(app.id, 4)).planId).not.toBe(plan.planId);
    expect((await planVersionDeletion((await everyReason()).id, 9)).planId).not.toBe(plan.planId);

    // v3 is kept between the preview and the confirm: the plan changed.
    await keepVersion(app.id, 3, true, ann, { keptMax: 5 });
    const err = await refusal(deleteVersions(app.id, 9, { expectedPlanId: plan.planId }, ann));
    expect(err.code).toBe('plan_changed');
    expect(await numbers(app.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(await auditOf(app.workspaceId, 'app.versions.delete')).toHaveLength(0);

    // A version that becomes deletable after the preview widens the plan too.
    await keepVersion(app.id, 3, false, ann, { keptMax: 5 });
    await keepVersion(app.id, 1, false, ann, { keptMax: 5 });
    expect((await refusal(deleteVersions(app.id, 9, { expectedPlanId: plan.planId }, ann))).code).toBe('plan_changed');
    expect(await numbers(app.id)).toHaveLength(9);

    // The plan the member saw again: exactly those versions go.
    await keepVersion(app.id, 1, true, ann, { keptMax: 5 });
    expect(await deleteVersions(app.id, 9, { expectedPlanId: plan.planId }, ann)).toEqual(plan);
    expect(await numbers(app.id)).toEqual([1, 2, 4, 6, 8, 9]);
  });

  it('with expectedPlanId deletes a plan larger than one batch', async () => {
    const app = await newApp();
    await db.insert(appVersions).values(
      Array.from({ length: 205 }, (_, i) => ({
        appId: app.id,
        number: i + 1,
        actorKind: 'agent' as const,
        compileStatus: 'error' as const,
        createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      }))
    );
    const plan = await planVersionDeletion(app.id, 205);
    expect(plan.count).toBe(204);
    const out = await deleteVersions(app.id, 205, { expectedPlanId: plan.planId }, ann);
    expect(out).toEqual(plan);
    expect(await numbers(app.id)).toEqual([205]);
  });

  it('refuses on a taken-down app and an unknown one', async () => {
    const app = await everyReason();
    await db.update(apps).set({ lockedReason: 'phishing' }).where(eq(apps.id, app.id));
    expect((await refusal(planVersionDeletion(app.id, 9))).code).toBe('app_locked_by_admin');
    expect((await refusal(deleteVersions(app.id, 9, {}, ann))).code).toBe('app_locked_by_admin');
    expect(await numbers(app.id)).toHaveLength(9);
    expect((await refusal(deleteVersions('no-such-app', 9, {}, ann))).code).toBe('not_found');
  });
});
