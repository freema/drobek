import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users, workspaces } from '@drobek/db';
import { AppsError, DEFAULT_APPS_MAX_PER_WORKSPACE, createApp, softDeleteApp, type Actor } from './index.js';
import { freshDb, type TestDb } from './test/db.js';

let db: TestDb;
let close: () => Promise<void>;
let actor: Actor;

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const [u] = await db.insert(users).values({ email: 'limit-owner@example.test' }).returning();
  actor = { userId: u.id, kind: 'user' };
});
afterAll(async () => close());

async function workspace(slug: string): Promise<string> {
  const [w] = await db.insert(workspaces).values({ kind: 'team', slug, name: slug }).returning();
  return w.id;
}

async function err(p: Promise<unknown>): Promise<AppsError | undefined> {
  return p.then(
    () => undefined,
    (e: unknown) => e as AppsError
  );
}

describe('createApp — APPS_MAX_PER_WORKSPACE (NSO-329)', () => {
  it('the (max + 1)-th live app is limit_exceeded, naming the limit', async () => {
    const wsId = await workspace('lim-two');
    await createApp({ workspaceId: wsId, slug: 'lim-two-a', actor, maxApps: 2 });
    await createApp({ workspaceId: wsId, slug: 'lim-two-b', actor, maxApps: 2 });
    const e = await err(createApp({ workspaceId: wsId, slug: 'lim-two-c', actor, maxApps: 2 }));
    expect(e).toBeInstanceOf(AppsError);
    expect(e?.code).toBe('limit_exceeded');
    expect(e?.message).toContain('APPS_MAX_PER_WORKSPACE');
    expect(e?.details).toEqual({ limit: 'APPS_MAX_PER_WORKSPACE', value: 2 });
    // A higher plan lets the same workspace grow.
    await expect(createApp({ workspaceId: wsId, slug: 'lim-two-c', actor, maxApps: 3 })).resolves.toMatchObject({ slug: 'lim-two-c' });
  });

  it('soft-deleted apps do not count', async () => {
    const wsId = await workspace('lim-del');
    const a = await createApp({ workspaceId: wsId, slug: 'lim-del-a', actor, maxApps: 1 });
    expect((await err(createApp({ workspaceId: wsId, slug: 'lim-del-b', actor, maxApps: 1 })))?.code).toBe('limit_exceeded');
    await softDeleteApp(a.id, actor);
    await expect(createApp({ workspaceId: wsId, slug: 'lim-del-b', actor, maxApps: 1 })).resolves.toMatchObject({ slug: 'lim-del-b' });
  });

  it('counts per workspace', async () => {
    const one = await workspace('lim-ws-one');
    const two = await workspace('lim-ws-two');
    await createApp({ workspaceId: one, slug: 'lim-ws-one-a', actor, maxApps: 1 });
    await expect(createApp({ workspaceId: two, slug: 'lim-ws-two-a', actor, maxApps: 1 })).resolves.toBeTruthy();
  });

  it('concurrent creates cannot both pass the limit', async () => {
    const wsId = await workspace('lim-race');
    const out = await Promise.allSettled(
      ['lim-race-a', 'lim-race-b', 'lim-race-c'].map((slug) => createApp({ workspaceId: wsId, slug, actor, maxApps: 1 }))
    );
    expect(out.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('without maxApps: the env var, else the default of 50', async () => {
    expect(DEFAULT_APPS_MAX_PER_WORKSPACE).toBe(50);
    const wsId = await workspace('lim-env');
    const prev = process.env.APPS_MAX_PER_WORKSPACE;
    process.env.APPS_MAX_PER_WORKSPACE = '1';
    try {
      await createApp({ workspaceId: wsId, slug: 'lim-env-a', actor });
      const e = await err(createApp({ workspaceId: wsId, slug: 'lim-env-b', actor }));
      expect(e?.details).toEqual({ limit: 'APPS_MAX_PER_WORKSPACE', value: 1 });
      process.env.APPS_MAX_PER_WORKSPACE = 'zero';
      await expect(createApp({ workspaceId: wsId, slug: 'lim-env-b', actor })).resolves.toBeTruthy();
    } finally {
      if (prev === undefined) delete process.env.APPS_MAX_PER_WORKSPACE;
      else process.env.APPS_MAX_PER_WORKSPACE = prev;
    }
  });
});
