/**
 * The version history tools over a real MCP client on a real (PGlite)
 * database: list_versions pages the history with `next_before` and flags the
 * published, preview and kept versions; keep_version keeps one under
 * APP_VERSIONS_KEPT_MAX; delete_versions asks for the user's yes with the plan,
 * then deletes for good and reports what stayed and why. Listing takes any
 * role, keeping and deleting editor+.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createVersion, publish, takedownApp, type Actor } from '@drobek/apps';
import { appVersions, apps, auditLog, memberships, users, workspaces } from '@drobek/db';
import type { ModuleRuntime } from '@drobek/modules';
import type { ToolPrincipal } from './context.js';
import { freshDb, type TestDb } from './test/db.js';
import { connect, testDeps, type TestDeps } from './test/harness.js';

let db: TestDb;
let close: () => Promise<void>;
const P = {} as Record<'alice' | 'ed' | 'vera' | 'eve', ToolPrincipal>;
let wsId: string;
let rootId: string;
let deps: TestDeps;

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const mk = async (email: string) => (await db.insert(users).values({ email }).returning())[0].id;
  const ids = {
    alice: await mk('alice@example.test'),
    ed: await mk('ed@example.test'),
    vera: await mk('vera@example.test'),
    eve: await mk('eve@example.test'),
  };
  rootId = await mk('root@example.test');
  const [team] = await db.insert(workspaces).values({ kind: 'team', slug: 'team-v', name: 'Versions' }).returning();
  const [other] = await db.insert(workspaces).values({ kind: 'personal', slug: 'eve-v', name: 'Eve' }).returning();
  wsId = team.id;
  await db.insert(memberships).values([
    { userId: ids.alice, workspaceId: team.id, role: 'workspace-admin' },
    { userId: ids.ed, workspaceId: team.id, role: 'editor' },
    { userId: ids.vera, workspaceId: team.id, role: 'viewer' },
    { userId: ids.eve, workspaceId: other.id, role: 'workspace-admin' },
  ]);
  for (const k of Object.keys(ids) as (keyof typeof ids)[]) P[k] = { userId: ids[k], email: `${k}@example.test`, superAdmin: false };
});
afterAll(async () => close());
beforeEach(() => {
  deps = testDeps();
  deps.env = { APPS_DOMAIN: 'drobek.app', PUBLIC_APP_URL: 'https://dash.drobek.test' };
});

let n = 0;
const unlimited = { perApp: 1_000_000, perUser: 1_000_000 };

/**
 * An app with versions 1..count (each `ok` unless listed in `failed`), all
 * older than an hour; `published` is put live.
 */
async function newApp(count: number, opts: { failed?: number[]; published?: number } = {}): Promise<{ id: string; slug: string; versionIds: string[] }> {
  n += 1;
  const [a] = await db.insert(apps).values({ workspaceId: wsId, slug: `hist-${n}`, name: `Hist ${n}` }).returning();
  const actor: Actor = { userId: P.alice.userId, kind: 'user' };
  const versionIds: string[] = [];
  for (let i = 1; i <= count; i++) {
    const failed = opts.failed?.includes(i) ?? false;
    const v = await createVersion(a.id, [{ path: 'index.html', content: `<h1>${a.slug} ${i}</h1>` }], {
      actor,
      reasoning: `write ${i}`,
      versionLimits: unlimited,
      compile: { status: failed ? 'error' : 'ok' },
    });
    versionIds.push(v.id);
  }
  if (opts.published) await publish(a.id, versionIds[opts.published - 1], actor);
  await db
    .update(appVersions)
    .set({ createdAt: sql`${appVersions.createdAt} - make_interval(mins => 90)` })
    .where(eq(appVersions.appId, a.id));
  return { id: a.id, slug: a.slug, versionIds };
}

type Conn = Awaited<ReturnType<typeof connect>>;

async function as<T>(who: keyof typeof P, fn: (c: Conn) => Promise<T>): Promise<T> {
  const c = await connect(P[who], deps);
  try {
    return await fn(c);
  } finally {
    await c.close();
  }
}

function errorOf(r: { isError: boolean; text: string }): Record<string, unknown> {
  expect(r.isError, r.text).toBe(true);
  return JSON.parse(r.text) as Record<string, unknown>;
}

function ok(r: { isError: boolean; text: string; body: Record<string, unknown> }): Record<string, unknown> {
  expect(r.isError, r.text).toBe(false);
  return r.body;
}

async function stored(appId: string): Promise<number[]> {
  const rows = await db.select({ n: appVersions.number }).from(appVersions).where(eq(appVersions.appId, appId)).orderBy(appVersions.number);
  return rows.map((r) => r.n);
}

async function audits(slug: string, actions: string[]) {
  const rows = await db.select().from(auditLog).where(and(eq(auditLog.workspaceId, wsId), eq(auditLog.target, slug))).orderBy(auditLog.createdAt);
  return rows.filter((r) => actions.includes(r.action)).map((r) => ({ action: r.action, actorKind: r.actorKind, actorUserId: r.actorUserId, meta: r.meta }));
}

type Item = { number: number; published: boolean; preview: boolean; kept: boolean; compile_status: string; reasoning: string | null };

describe('list_versions', () => {
  it('pages newest first through next_before, with the flags and the pinned versions', async () => {
    const app = await newApp(5, { failed: [5], published: 2 });
    await as('ed', async (c) => ok(await c.call('keep_version', { app_id: app.id, version: 1, kept: true })));
    await as('vera', async (c) => {
      const first = ok(await c.call('list_versions', { app_id: app.id, limit: 2 }));
      expect((first.versions as Item[]).map((v) => v.number)).toEqual([5, 4]);
      expect(first.next_before).toBe(4);
      const second = ok(await c.call('list_versions', { app_id: app.id, limit: 2, before: first.next_before }));
      expect((second.versions as Item[]).map((v) => v.number)).toEqual([3, 2]);
      expect(second.next_before).toBe(2);
      const last = ok(await c.call('list_versions', { app_id: app.id, limit: 2, before: second.next_before }));
      expect((last.versions as Item[]).map((v) => v.number)).toEqual([1]);
      expect(last.next_before).toBeNull();

      const all = ok(await c.call('list_versions', { app_id: app.id }));
      const byNumber = new Map((all.versions as Item[]).map((v) => [v.number, v]));
      expect(byNumber.get(5)).toMatchObject({ compile_status: 'error', published: false, preview: false, kept: false, reasoning: 'write 5' });
      expect(byNumber.get(4)).toMatchObject({ preview: true, published: false, kept: false });
      expect(byNumber.get(2)).toMatchObject({ published: true, preview: false });
      expect(byNumber.get(1)).toMatchObject({ kept: true });
      expect(Object.keys(byNumber.get(3)!).sort()).toEqual(
        ['actor_kind', 'compile_status', 'created_at', 'kept', 'number', 'preview', 'published', 'reasoning'].sort()
      );
      expect(all.next_before).toBeNull();
      expect((all.pinned as Item[]).map((v) => v.number)).toEqual([4, 2, 1]);
      // Pinned on every page, also past them.
      expect((last.pinned as Item[]).map((v) => v.number)).toEqual([4, 2, 1]);
    });
  });

  it('a limit past APP_VERSIONS_PAGE or a bad cursor answers invalid_params; the default page is APP_VERSIONS_PAGE', async () => {
    const app = await newApp(4);
    deps.env = { ...deps.env, APP_VERSIONS_PAGE: '3' };
    await as('vera', async (c) => {
      for (const limit of [0, 4, 1.5, -1]) {
        const e = errorOf(await c.call('list_versions', { app_id: app.id, limit }));
        expect(e.code, String(limit)).toBe('invalid_params');
        expect(String(e.message)).toContain('APP_VERSIONS_PAGE');
      }
      for (const before of [0, -2, 2.5]) expect(errorOf(await c.call('list_versions', { app_id: app.id, before })).code).toBe('invalid_params');
      const page = ok(await c.call('list_versions', { app_id: app.id }));
      expect((page.versions as Item[]).map((v) => v.number)).toEqual([4, 3, 2]);
      expect(page.next_before).toBe(2);
    });
  });

  it('a non-member gets not_found', async () => {
    const app = await newApp(1);
    await as('eve', async (c) => expect(errorOf(await c.call('list_versions', { app_id: app.id })).code).toBe('not_found'));
  });
});

describe('get_app', () => {
  it('the versions say published, preview and kept', async () => {
    const app = await newApp(3, { failed: [3], published: 1 });
    await as('ed', async (c) => {
      ok(await c.call('keep_version', { app_id: app.id, version: 2, kept: true }));
      const got = ok(await c.call('get_app', { app_id: app.id }));
      expect((got.versions as Item[]).map((v) => [v.number, v.published, v.preview, v.kept])).toEqual([
        [3, false, false, false],
        [2, false, true, true],
        [1, true, false, false],
      ]);
    });
  });
});

describe('keep_version', () => {
  it('keeps and stops keeping, audited as the agent; the same state answers changed:false', async () => {
    const app = await newApp(3);
    await as('ed', async (c) => {
      expect(ok(await c.call('keep_version', { app_id: app.id, version: 2, kept: true }))).toMatchObject({ version: 2, kept: true, changed: true });
      const again = ok(await c.call('keep_version', { app_id: app.id, version: 2, kept: true }));
      expect(again).toMatchObject({ kept: true, changed: false });
      expect(again).not.toHaveProperty('prunable');
      const off = ok(await c.call('keep_version', { app_id: app.id, version: 2, kept: false }));
      expect(off).toMatchObject({ version: 2, kept: false, changed: true, prunable: false });
    });
    expect(await audits(app.slug, ['app.version.keep', 'app.version.unkeep'])).toEqual([
      expect.objectContaining({ action: 'app.version.keep', actorKind: 'agent', actorUserId: P.ed.userId, meta: { appId: app.id, version: 2 } }),
      expect.objectContaining({ action: 'app.version.unkeep', actorKind: 'agent', actorUserId: P.ed.userId, meta: { appId: app.id, version: 2 } }),
    ]);
  });

  it('prunable after an unkeep when the version is past APP_VERSIONS_KEEP and nothing else protects it', async () => {
    const app = await newApp(4);
    const real = deps.modules;
    deps.modules = async () => {
      const rt = await real();
      const limited = Object.create(rt) as ModuleRuntime;
      limited.workspaceLimits = async (id: string) => ({ ...(await rt.workspaceLimits(id)), APP_VERSIONS_KEEP: 2 });
      return limited;
    };
    await as('ed', async (c) => {
      ok(await c.call('keep_version', { app_id: app.id, version: 1, kept: true }));
      const off = ok(await c.call('keep_version', { app_id: app.id, version: 1, kept: false }));
      expect(off).toMatchObject({ kept: false, prunable: true });
      expect(String(off.note)).toContain('next hourly history retention deletes it');
    });
  });

  it('past APP_VERSIONS_KEPT_MAX answers limit_exceeded and keeps nothing more', async () => {
    const app = await newApp(3);
    const real = deps.modules;
    deps.modules = async () => {
      const rt = await real();
      const limited = Object.create(rt) as ModuleRuntime;
      limited.workspaceLimits = async (id: string) => ({ ...(await rt.workspaceLimits(id)), APP_VERSIONS_KEPT_MAX: 1 });
      return limited;
    };
    await as('ed', async (c) => {
      ok(await c.call('keep_version', { app_id: app.id, version: 1, kept: true }));
      const e = errorOf(await c.call('keep_version', { app_id: app.id, version: 2, kept: true }));
      expect(e).toMatchObject({ code: 'limit_exceeded', limit: 'APP_VERSIONS_KEPT_MAX', value: 1 });
      expect(String(e.hint)).toContain('APP_VERSIONS_KEPT_MAX');
    });
    const kept = await db.select({ n: appVersions.number }).from(appVersions).where(and(eq(appVersions.appId, app.id), sql`${appVersions.keptAt} IS NOT NULL`));
    expect(kept.map((r) => r.n)).toEqual([1]);
  });

  it('a viewer is refused, a non-member gets not_found, a missing version not_found, bad arguments invalid_params', async () => {
    const app = await newApp(2);
    await as('vera', async (c) => expect(errorOf(await c.call('keep_version', { app_id: app.id, version: 1, kept: true })).code).toBe('forbidden'));
    await as('eve', async (c) => expect(errorOf(await c.call('keep_version', { app_id: app.id, version: 1, kept: true })).code).toBe('not_found'));
    await as('ed', async (c) => {
      const missing = errorOf(await c.call('keep_version', { app_id: app.id, version: 9, kept: true }));
      expect(missing.code).toBe('not_found');
      expect(String(missing.message)).toContain('the newest version is 2');
      expect(errorOf(await c.call('keep_version', { app_id: app.id, version: 0, kept: true })).code).toBe('invalid_params');
    });
  });

  it('works on a taken-down app', async () => {
    const app = await newApp(2);
    await takedownApp({ appId: app.id, reason: 'spam', actorUserId: rootId });
    await as('ed', async (c) => expect(ok(await c.call('keep_version', { app_id: app.id, version: 1, kept: true }))).toMatchObject({ kept: true, changed: true }));
  });
});

describe('delete_versions', () => {
  it('asks first with the plan and changes nothing; with the yes deletes, audited, and names what stayed and why', async () => {
    const app = await newApp(8, { published: 2, failed: [8] });
    await as('ed', async (c) => {
      ok(await c.call('keep_version', { app_id: app.id, version: 4, kept: true }));
      const ask = errorOf(await c.call('delete_versions', { app_id: app.id, up_to: 8 }));
      expect(ask).toMatchObject({
        code: 'user_confirmation_required',
        app_id: app.id,
        up_to: 8,
        failed_only: false,
        delete: ['1', '3', '5-6'],
        count: 4,
        skipped: { published: ['2'], kept: ['4'], preview: ['7'], newest: ['8'] },
        plan_id: expect.stringMatching(/^[0-9a-f]+$/),
      });
      const planId = String(ask.plan_id);
      expect(String(ask.message)).toContain(`plan_id: "${planId}"`);
      expect(String(ask.message)).toContain(`Delete 4 old versions of Hist ${n} for good?`);
      expect(String(ask.hint)).toContain('Delete N old versions of <app> for good?');
      expect(errorOf(await c.call('delete_versions', { app_id: app.id, up_to: 8, user_confirmed: false })).code).toBe('user_confirmation_required');
      // The yes without the plan it answers deletes nothing.
      expect(errorOf(await c.call('delete_versions', { app_id: app.id, up_to: 8, user_confirmed: true })).code).toBe('invalid_params');
      expect(await stored(app.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

      const done = ok(await c.call('delete_versions', { app_id: app.id, up_to: 8, plan_id: planId, user_confirmed: true }));
      expect(done).toMatchObject({ deleted: ['1', '3', '5-6'], count: 4, skipped: { published: ['2'], kept: ['4'], preview: ['7'], newest: ['8'] } });
      expect(await stored(app.id)).toEqual([2, 4, 7, 8]);

      // Nothing left to delete: answered without asking.
      expect(ok(await c.call('delete_versions', { app_id: app.id, up_to: 8 }))).toMatchObject({ deleted: [], count: 0 });
    });
    expect(await audits(app.slug, ['app.versions.delete'])).toEqual([
      expect.objectContaining({
        action: 'app.versions.delete',
        actorKind: 'agent',
        actorUserId: P.ed.userId,
        meta: { appId: app.id, count: 4, from: 1, to: 6, failedOnly: false },
      }),
    ]);
  });

  it('failed_only deletes only the failed builds; the last hour\'s versions stay as recent', async () => {
    const app = await newApp(5, { failed: [1, 3] });
    const actor: Actor = { userId: P.alice.userId, kind: 'user' };
    await createVersion(app.id, [{ path: 'index.html', content: '<h1>fresh</h1>' }], { actor, versionLimits: unlimited, compile: { status: 'error' } });
    await createVersion(app.id, [{ path: 'index.html', content: '<h1>fresher</h1>' }], { actor, versionLimits: unlimited, compile: { status: 'ok' } });
    await as('ed', async (c) => {
      const ask = errorOf(await c.call('delete_versions', { app_id: app.id, up_to: 7, failed_only: true }));
      const done = ok(await c.call('delete_versions', { app_id: app.id, up_to: 7, failed_only: true, plan_id: ask.plan_id, user_confirmed: true }));
      expect(done).toMatchObject({ deleted: ['1', '3'], count: 2, skipped: { recent: ['6'] } });
      expect(await stored(app.id)).toEqual([2, 4, 5, 6, 7]);
    });
  });

  it('refuses with plan_changed and deletes nothing when the versions that would go changed after the question', async () => {
    const app = await newApp(6, { published: 2 });
    await as('ed', async (c) => {
      const ask = errorOf(await c.call('delete_versions', { app_id: app.id, up_to: 6 }));
      expect(ask).toMatchObject({ code: 'user_confirmation_required', delete: ['1', '3-5'], count: 4 });
      ok(await c.call('keep_version', { app_id: app.id, version: 3, kept: true }));
      const changed = errorOf(await c.call('delete_versions', { app_id: app.id, up_to: 6, plan_id: ask.plan_id, user_confirmed: true }));
      expect(changed).toMatchObject({ code: 'plan_changed', app_id: app.id, plan_id: ask.plan_id });
      expect(String(changed.hint)).toContain('delete_versions');
      expect(await stored(app.id)).toEqual([1, 2, 3, 4, 5, 6]);

      const again = errorOf(await c.call('delete_versions', { app_id: app.id, up_to: 6 }));
      expect(again).toMatchObject({ delete: ['1', '4-5'], count: 3 });
      expect(again.plan_id).not.toBe(ask.plan_id);
      expect(ok(await c.call('delete_versions', { app_id: app.id, up_to: 6, plan_id: again.plan_id, user_confirmed: true }))).toMatchObject({
        deleted: ['1', '4-5'],
        count: 3,
      });
      expect(await stored(app.id)).toEqual([2, 3, 6]);
    });
    expect(await audits(app.slug, ['app.versions.delete'])).toHaveLength(1);
  });

  it('a viewer is refused, a non-member gets not_found, bad arguments invalid_params, a taken-down app app_locked_by_admin — all before the question', async () => {
    const app = await newApp(3);
    await as('vera', async (c) => expect(errorOf(await c.call('delete_versions', { app_id: app.id, up_to: 2 })).code).toBe('forbidden'));
    await as('eve', async (c) => expect(errorOf(await c.call('delete_versions', { app_id: app.id, up_to: 2 })).code).toBe('not_found'));
    await as('ed', async (c) => {
      for (const up_to of [0, 1.5, -3]) expect(errorOf(await c.call('delete_versions', { app_id: app.id, up_to })).code).toBe('invalid_params');
      expect(errorOf(await c.call('delete_versions', { app_id: app.id, up_to: 2, plan_id: 'not a plan' })).code).toBe('invalid_params');
    });
    await takedownApp({ appId: app.id, reason: 'spam', actorUserId: rootId });
    await as('ed', async (c) => {
      expect(errorOf(await c.call('delete_versions', { app_id: app.id, up_to: 2 }))).toMatchObject({ code: 'app_locked_by_admin', reason: 'spam' });
      expect(errorOf(await c.call('delete_versions', { app_id: app.id, up_to: 2, user_confirmed: true })).code).toBe('app_locked_by_admin');
    });
    expect(await stored(app.id)).toEqual([1, 2, 3]);
  });
});
