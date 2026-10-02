/**
 * The rate limit on new versions on a real (PGlite) database: per app and
 * per person within the last hour, for writes and restores alike; a refusal
 * stores nothing (no version row, no blob) and says when to retry; versions
 * that left the window give the budget back.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appVersions, blobs, users, workspaces } from '@drobek/db';
import {
  AppsError,
  DEFAULT_VERSIONS_PER_APP_HOUR,
  DEFAULT_VERSIONS_PER_USER_HOUR,
  assertVersionRate,
  createApp,
  createVersion,
  latestVersionNumber,
  restore,
  versionRateLimits,
  versionRateLimitsOf,
  type Actor,
  type VersionRateLimits,
} from './index.js';
import { freshDb, type TestDb } from './test/db.js';

let db: TestDb;
let close: () => Promise<void>;
let wsId: string;
let ann: Actor;
let bob: Actor;

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const [a] = await db.insert(users).values({ email: 'ann@example.test' }).returning();
  const [b] = await db.insert(users).values({ email: 'bob@example.test' }).returning();
  const [w] = await db.insert(workspaces).values({ kind: 'team', slug: 'rate', name: 'Rate' }).returning();
  wsId = w.id;
  ann = { userId: a.id, kind: 'agent' };
  bob = { userId: b.id, kind: 'agent' };
});
afterAll(async () => close());

let n = 0;
async function newApp(): Promise<string> {
  n += 1;
  return (await createApp({ workspaceId: wsId, slug: `rated-${n}`, actor: ann })).id;
}

function write(appId: string, actor: Actor, versionLimits: VersionRateLimits, content = `<p>${Math.random()}</p>`) {
  return createVersion(appId, [{ path: 'index.html', content }], { actor, versionLimits, compile: { status: 'ok' } });
}

/** Move every version of `where` `minutes` back in time. */
async function age(where: ReturnType<typeof eq>, minutes: number): Promise<void> {
  await db
    .update(appVersions)
    .set({ createdAt: sql`${appVersions.createdAt} - make_interval(mins => ${minutes})` })
    .where(where);
}

const blobCount = async () => Number((await db.select({ c: sql<number>`count(*)` }).from(blobs))[0].c);

describe('versionRateLimits', () => {
  it('reads VERSIONS_PER_APP_HOUR / VERSIONS_PER_USER_HOUR, else the production defaults', () => {
    expect(versionRateLimits({})).toEqual({ perApp: DEFAULT_VERSIONS_PER_APP_HOUR, perUser: DEFAULT_VERSIONS_PER_USER_HOUR });
    expect(DEFAULT_VERSIONS_PER_APP_HOUR).toBe(600);
    expect(DEFAULT_VERSIONS_PER_USER_HOUR).toBe(1200);
    expect(versionRateLimits({ VERSIONS_PER_APP_HOUR: '30', VERSIONS_PER_USER_HOUR: ' 90 ' })).toEqual({ perApp: 30, perUser: 90 });
    for (const bad of ['0', '-1', '1.5', 'many', '']) {
      expect(versionRateLimits({ VERSIONS_PER_APP_HOUR: bad, VERSIONS_PER_USER_HOUR: bad })).toEqual({ perApp: 600, perUser: 1200 });
    }
  });

  it("takes a workspace's limits (the plan) over the env", () => {
    const env = { VERSIONS_PER_APP_HOUR: '30' };
    expect(versionRateLimitsOf({ VERSIONS_PER_APP_HOUR: 5, VERSIONS_PER_USER_HOUR: 7 }, env)).toEqual({ perApp: 5, perUser: 7 });
    expect(versionRateLimitsOf({ APPS_MAX_PER_WORKSPACE: 50 }, env)).toEqual({ perApp: 30, perUser: 1200 });
  });
});

describe('VERSIONS_PER_APP_HOUR', () => {
  const limits = { perApp: 3, perUser: 1000 };

  it('refuses the next version of the app with rate_limited and retry_after_seconds; nothing is stored', async () => {
    const appId = await newApp();
    for (let i = 0; i < 3; i++) await write(appId, i % 2 ? bob : ann, limits);
    const blobsBefore = await blobCount();

    const err = await write(appId, ann, limits, '<p>one too many</p>').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppsError);
    expect((err as AppsError).code).toBe('rate_limited');
    expect((err as AppsError).message).toContain('VERSIONS_PER_APP_HOUR');
    expect((err as AppsError).message).toContain('nothing was stored');
    const details = (err as AppsError).details!;
    expect(details).toMatchObject({ limit: 'VERSIONS_PER_APP_HOUR', value: 3 });
    expect(details.retry_after_seconds).toBeGreaterThan(3500);
    expect(details.retry_after_seconds).toBeLessThanOrEqual(3600);
    expect(await latestVersionNumber(appId)).toBe(3);
    expect(await blobCount()).toBe(blobsBefore);

    // The pre-check answers the same, and another app is not affected.
    await expect(assertVersionRate({ appId, userId: null }, limits)).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(write(await newApp(), ann, limits)).resolves.toMatchObject({ number: 1 });
  });

  it('a restore counts and is refused like a write', async () => {
    const appId = await newApp();
    await write(appId, ann, limits);
    await write(appId, ann, limits);
    await expect(restore(appId, 1, ann, { versionLimits: limits })).resolves.toMatchObject({ number: 3 });
    await expect(restore(appId, 1, ann, { versionLimits: limits })).rejects.toMatchObject({
      code: 'rate_limited',
      details: { limit: 'VERSIONS_PER_APP_HOUR', value: 3 },
    });
    await expect(write(appId, ann, limits)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(await latestVersionNumber(appId)).toBe(3);
  });

  it('retry_after_seconds is when the oldest version of the full window leaves it; then one more fits', async () => {
    const appId = await newApp();
    for (let i = 0; i < 3; i++) await write(appId, ann, limits);
    await age(eq(appVersions.appId, appId), 50);
    const err = (await write(appId, ann, limits).catch((e: unknown) => e)) as AppsError;
    expect(err.details?.retry_after_seconds).toBeGreaterThan(500);
    expect(err.details?.retry_after_seconds).toBeLessThanOrEqual(600);
    expect(err.message).toContain('Try again in 10 min.');

    await age(eq(appVersions.appId, appId), 11);
    await expect(write(appId, ann, limits)).resolves.toMatchObject({ number: 4 });
    // The three old ones are out of the window, the new one is in: two more fit.
    await write(appId, ann, limits);
    await write(appId, ann, limits);
    await expect(write(appId, ann, limits)).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('without explicit limits the env applies (default 600)', async () => {
    const appId = await newApp();
    await expect(createVersion(appId, [{ path: 'index.html', content: 'x' }], { actor: ann })).resolves.toMatchObject({ number: 1 });
  });
});

describe('VERSIONS_PER_USER_HOUR', () => {
  it("counts the person's versions in every app; other people and system writes are not affected", async () => {
    const [carl] = await db.insert(users).values({ email: 'carl@example.test' }).returning();
    const [other] = await db.insert(workspaces).values({ kind: 'personal', slug: 'carl', name: 'Carl' }).returning();
    const actor: Actor = { userId: carl.id, kind: 'user' };
    const limits = { perApp: 1000, perUser: 4 };
    const one = await newApp();
    const two = (await createApp({ workspaceId: other.id, slug: 'carl-own', actor })).id;
    await write(one, actor, limits);
    await write(two, actor, limits);
    await write(one, actor, limits);
    await restore(one, 1, actor, { versionLimits: limits });

    const err = (await write(two, actor, limits).catch((e: unknown) => e)) as AppsError;
    expect(err).toBeInstanceOf(AppsError);
    expect(err.code).toBe('rate_limited');
    expect(err.details).toMatchObject({ limit: 'VERSIONS_PER_USER_HOUR', value: 4 });
    expect(err.details?.retry_after_seconds).toBeGreaterThan(3500);
    expect(err.message).toContain('across all your apps');
    await expect(restore(one, 1, actor, { versionLimits: limits })).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(assertVersionRate({ userId: carl.id }, limits)).rejects.toMatchObject({ code: 'rate_limited' });

    // Bob writes the same app; a write without a person (userId null) has no personal budget.
    await expect(write(one, bob, limits)).resolves.toBeTruthy();
    await expect(write(one, { userId: null, kind: 'agent' }, limits)).resolves.toBeTruthy();

    // An hour later the budget is back.
    await age(eq(appVersions.createdByUserId, carl.id), 61);
    await expect(write(two, actor, limits)).resolves.toMatchObject({ number: 2 });
  });
});
