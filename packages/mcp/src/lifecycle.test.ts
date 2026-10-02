/**
 * The app lifecycle tools over a real MCP client on a real (PGlite)
 * database: unpublish, set_visibility, set_frame_ancestors, release_lease and
 * delete_app do what the dashboard's app page does, through the same
 * @drobek/apps functions — the change itself, the audit row (as the agent),
 * the serve-cache bust — with the dashboard's role floor (editor+; a viewer
 * gets forbidden, a non-member not_found). What changes the public site needs
 * `user_confirmed: true`; a password never passes through MCP
 * (`password_not_set` with the Settings link); release_lease frees only the
 * caller's own lease.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createVersion, leaseKey, publish, setAppVisibility, takedownApp, type Actor } from '@drobek/apps';
import { apps, auditLog, memberships, users, workspaces } from '@drobek/db';
import type { ModuleRuntime } from '@drobek/modules';
import type { ToolPrincipal } from './context.js';
import { redisLeaseStore } from './lease.js';
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
  const [team] = await db.insert(workspaces).values({ kind: 'team', slug: 'team-l', name: 'Lifecycle' }).returning();
  const [other] = await db.insert(workspaces).values({ kind: 'personal', slug: 'eve-l', name: 'Eve' }).returning();
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
  deps.env = { APPS_DOMAIN: 'drobek.app', PUBLIC_APP_URL: 'https://dash.drobek.test', GALLERY_ENABLED: 'true' };
});

let n = 0;
async function newApp(opts: { published?: boolean } = {}): Promise<{ id: string; slug: string }> {
  n += 1;
  const [a] = await db.insert(apps).values({ workspaceId: wsId, slug: `life-${n}`, name: `Life ${n}` }).returning();
  if (opts.published) {
    const actor: Actor = { userId: P.alice.userId, kind: 'user' };
    const v = await createVersion(a.id, [{ path: 'index.html', content: '<h1>x</h1>' }], { actor, compile: { status: 'ok' } });
    await publish(a.id, v.id, actor);
  }
  return { id: a.id, slug: a.slug };
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

async function row(id: string) {
  const [r] = await db.select().from(apps).where(eq(apps.id, id));
  return r;
}

async function audits(slug: string, prefix: string): Promise<{ action: string; actorKind: string; actorUserId: string | null; meta: unknown }[]> {
  const rows = await db.select().from(auditLog).where(and(eq(auditLog.workspaceId, wsId), eq(auditLog.target, slug))).orderBy(auditLog.createdAt);
  return rows
    .filter((r) => r.action.startsWith(prefix))
    .map((r) => ({ action: r.action, actorKind: r.actorKind, actorUserId: r.actorUserId, meta: r.meta }));
}

describe('unpublish', () => {
  it('asks first, then takes the app off production: audited as the agent, the hosts told, the gallery listing ended', async () => {
    const app = await newApp({ published: true });
    await db.update(apps).set({ galleryListed: true, galleryDescription: 'Listed.' }).where(eq(apps.id, app.id));
    await as('ed', async (c) => {
      const ask = errorOf(await c.call('unpublish', { app_id: app.id }));
      expect(ask).toMatchObject({ code: 'user_confirmation_required', published_url: `https://${app.slug}.drobek.app`, domains: [] });
      expect(String(ask.message)).toMatch(/Ask the user whether to unpublish "Life \d+"/);
      expect(String(ask.message)).toContain('leaves the public gallery');
      expect(errorOf(await c.call('unpublish', { app_id: app.id, user_confirmed: false })).code).toBe('user_confirmation_required');
      expect((await row(app.id)).publishedVersionId).not.toBeNull();
      expect(deps.events).toEqual([]);

      const out = ok(await c.call('unpublish', { app_id: app.id, user_confirmed: true }));
      expect(out).toMatchObject({ app_id: app.id, unpublished_version: 1, gallery_unlisted: true });
      expect(String(out.note)).toContain(`https://${app.slug}.drobek.app`);
      const after = await row(app.id);
      expect(after.publishedVersionId).toBeNull();
      expect(after.galleryListed).toBe(false);
      expect(deps.events).toEqual([{ app_id: app.id, slug: app.slug, kind: 'unpublish' }]);
      expect(await audits(app.slug, 'app.')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'app.unpublish', actorKind: 'agent', actorUserId: P.ed.userId, meta: { previousVersion: 1 } }),
          expect.objectContaining({ action: 'app.gallery_unlisted', actorKind: 'agent' }),
        ])
      );

      // Nothing published: refused before the user is asked.
      expect(errorOf(await c.call('unpublish', { app_id: app.id }))).toMatchObject({ code: 'not_published' });
      expect(errorOf(await c.call('unpublish', { app_id: app.id, user_confirmed: true }))).toMatchObject({ code: 'not_published' });
    });
  });

  it('a taken-down app answers app_locked_by_admin; a viewer forbidden; a non-member not_found', async () => {
    const taken = await newApp({ published: true });
    await takedownApp({ appId: taken.id, reason: 'spam', actorUserId: rootId });
    const app = await newApp({ published: true });
    await as('alice', async (c) => {
      expect(errorOf(await c.call('unpublish', { app_id: taken.id, user_confirmed: true }))).toMatchObject({ code: 'app_locked_by_admin', reason: 'spam' });
    });
    await as('vera', async (c) => {
      expect(errorOf(await c.call('unpublish', { app_id: app.id, user_confirmed: true }))).toMatchObject({ code: 'forbidden' });
    });
    await as('eve', async (c) => {
      expect(errorOf(await c.call('unpublish', { app_id: app.id, user_confirmed: true }))).toMatchObject({ code: 'not_found' });
    });
    expect((await row(app.id)).publishedVersionId).not.toBeNull();
  });
});

describe('set_visibility', () => {
  it('password needs one set in the dashboard: password_not_set with the Settings link, nothing changed', async () => {
    const app = await newApp();
    await as('ed', async (c) => {
      const e = errorOf(await c.call('set_visibility', { app_id: app.id, visibility: 'password' }));
      expect(e).toMatchObject({
        code: 'password_not_set',
        settings_url: `https://dash.drobek.test/workspaces/team-l/apps/${app.slug}/settings`,
      });
      expect(String(e.hint)).toMatch(/Never ask for the password in chat/);
      expect(e).not.toHaveProperty('password');
    });
    expect((await row(app.id)).visibility).toBe('public');
    expect(deps.events).toEqual([]);
  });

  it('public on a password-protected app asks first, then opens it and drops the password; audited, hosts told', async () => {
    const app = await newApp({ published: true });
    // The owner set a password in the dashboard.
    await setAppVisibility(app.id, { visibility: 'password', passwordHash: 'scrypt$aa$bb' }, { userId: P.alice.userId, kind: 'user' });
    await as('ed', async (c) => {
      // Re-applying the password the owner set: allowed, nothing changes.
      expect(ok(await c.call('set_visibility', { app_id: app.id, visibility: 'password' }))).toMatchObject({
        visibility: 'password',
        changed: false,
        settings_url: `https://dash.drobek.test/workspaces/team-l/apps/${app.slug}/settings`,
      });
      expect(ok(await c.call('get_app', { app_id: app.id }))).toMatchObject({ visibility: 'password' });

      const ask = errorOf(await c.call('set_visibility', { app_id: app.id, visibility: 'public' }));
      expect(ask).toMatchObject({ code: 'user_confirmation_required', visibility: 'public' });
      expect(String(ask.message)).toMatch(/removes its password/);
      expect((await row(app.id)).passwordHash).toBe('scrypt$aa$bb');

      const out = ok(await c.call('set_visibility', { app_id: app.id, visibility: 'public', user_confirmed: true }));
      expect(out).toMatchObject({ app_id: app.id, visibility: 'public', changed: true });
      const after = await row(app.id);
      expect(after.visibility).toBe('public');
      expect(after.passwordHash).toBeNull();
      expect(deps.events).toEqual([{ app_id: app.id, slug: app.slug, kind: 'settings' }]);

      // Already public: no question, no change.
      expect(ok(await c.call('set_visibility', { app_id: app.id, visibility: 'public' }))).toMatchObject({ changed: false });
      // …and the password is gone, so password needs the dashboard again.
      expect(errorOf(await c.call('set_visibility', { app_id: app.id, visibility: 'password' })).code).toBe('password_not_set');
    });
    const rows = await audits(app.slug, 'app.visibility.');
    expect(rows.map((r) => [r.action, r.actorKind])).toEqual([
      ['app.visibility.password', 'user'],
      ['app.visibility.public', 'agent'],
    ]);
    expect(JSON.stringify(rows)).not.toContain('scrypt');
  });

  it('a viewer gets forbidden; an unknown visibility is refused', async () => {
    const app = await newApp();
    await as('vera', async (c) => {
      expect(errorOf(await c.call('set_visibility', { app_id: app.id, visibility: 'public' }))).toMatchObject({ code: 'forbidden' });
    });
    await as('ed', async (c) => {
      expect((await c.call('set_visibility', { app_id: app.id, visibility: 'hidden' })).isError).toBe(true);
    });
  });
});

describe('set_frame_ancestors', () => {
  it('stores the dashboard\'s validated list, replaces it, clears it; audited old → new; get_app shows it', async () => {
    const app = await newApp();
    await as('ed', async (c) => {
      const set = ok(await c.call('set_frame_ancestors', { app_id: app.id, frame_ancestors: ' https://Intranet.Example.com  \'self\' https://intranet.example.com ' }));
      expect(set).toMatchObject({ app_id: app.id, frame_ancestors: "https://intranet.example.com 'self'", previous: null, changed: true });
      expect(String(set.note)).toContain("https://intranet.example.com 'self'");
      expect((await row(app.id)).frameAncestors).toBe("https://intranet.example.com 'self'");
      expect(ok(await c.call('get_app', { app_id: app.id }))).toMatchObject({ visibility: 'public', frame_ancestors: "https://intranet.example.com 'self'" });

      expect(ok(await c.call('set_frame_ancestors', { app_id: app.id, frame_ancestors: "https://intranet.example.com 'self'" }))).toMatchObject({ changed: false });

      for (const bad of ['https://x.example.com; script-src *', '*', 'https:', 'https://x.example.com/path', Array.from({ length: 11 }, (_, i) => `https://h${i}.example.com`).join(' ')]) {
        const e = errorOf(await c.call('set_frame_ancestors', { app_id: app.id, frame_ancestors: bad }));
        expect(e, bad).toMatchObject({ code: 'invalid_params' });
        expect(String(e.message), bad).toContain("'self'");
      }
      expect((await row(app.id)).frameAncestors).toBe("https://intranet.example.com 'self'");

      expect(ok(await c.call('set_frame_ancestors', { app_id: app.id, frame_ancestors: null }))).toMatchObject({
        frame_ancestors: null,
        previous: "https://intranet.example.com 'self'",
        changed: true,
        note: 'No other site may embed the app.',
      });
      ok(await c.call('set_frame_ancestors', { app_id: app.id, frame_ancestors: 'https://a.example.com' }));
      expect(ok(await c.call('set_frame_ancestors', { app_id: app.id, frame_ancestors: "'none'" }))).toMatchObject({ frame_ancestors: null, changed: true });
      expect(ok(await c.call('set_frame_ancestors', { app_id: app.id, frame_ancestors: '' }))).toMatchObject({ frame_ancestors: null, changed: false });
    });
    expect(deps.events.map((e) => e.kind)).toEqual(['settings', 'settings', 'settings', 'settings']);
    const rows = await audits(app.slug, 'app.frame_ancestors.');
    expect(rows.map((r) => r.meta)).toEqual([
      { previous: null, value: "https://intranet.example.com 'self'" },
      { previous: "https://intranet.example.com 'self'", value: null },
      { previous: null, value: 'https://a.example.com' },
      { previous: 'https://a.example.com', value: null },
    ]);
    expect(rows.every((r) => r.actorKind === 'agent')).toBe(true);
  });

  it('a viewer gets forbidden', async () => {
    const app = await newApp();
    await as('vera', async (c) => {
      expect(errorOf(await c.call('set_frame_ancestors', { app_id: app.id, frame_ancestors: 'https://a.example.com' }))).toMatchObject({ code: 'forbidden' });
    });
  });
});

describe('release_lease', () => {
  it('frees the caller\'s own lease (any session); another user\'s stays and answers app_locked', async () => {
    const app = await newApp();
    await as('ed', async (c) => {
      ok(await c.call('write_files', { app_id: app.id, files: [{ path: 'index.html', content: '<h1>ed</h1>' }], reasoning: 'start' }));
      expect((await deps.leases.get([app.id])).get(app.id)?.holder_user_id).toBe(P.ed.userId);
    });
    // Alice's agent is locked out while Ed's holds it, and cannot free Ed's lease.
    await as('alice', async (c) => {
      expect(errorOf(await c.call('write_files', { app_id: app.id, files: [{ path: 'a.txt', content: 'a' }], reasoning: 'x' })).code).toBe('app_locked');
      const e = errorOf(await c.call('release_lease', { app_id: app.id }));
      expect(e).toMatchObject({ code: 'app_locked', holder: expect.stringContaining('***') });
      expect(String(e.message)).toMatch(/frees only your own lease/);
    });
    expect((await deps.leases.get([app.id])).get(app.id)?.holder_user_id).toBe(P.ed.userId);

    // Ed's other session releases it; Alice writes at once.
    await as('ed', async (c) => {
      expect(ok(await c.call('release_lease', { app_id: app.id }))).toMatchObject({ app_id: app.id, released: true });
      expect(ok(await c.call('release_lease', { app_id: app.id }))).toMatchObject({ released: false, note: 'Nobody held the write lease of this app.' });
    });
    await as('alice', async (c) => {
      ok(await c.call('write_files', { app_id: app.id, files: [{ path: 'a.txt', content: 'a' }], reasoning: 'x' }));
    });
    await as('vera', async (c) => {
      expect(errorOf(await c.call('release_lease', { app_id: app.id }))).toMatchObject({ code: 'forbidden' });
    });
  });

  it('the Redis store releases through @drobek/apps: only the holder\'s lease, audited app.lock.release as the agent', async () => {
    const app = await newApp();
    const store = new Map<string, string>();
    // The holder-only take script's replies: nil when free, {1, value} removed, {0, value} another holder's.
    const redis = {
      get: async (key: string) => store.get(key) ?? null,
      mget: async (...keys: string[]) => keys.map((k) => store.get(k) ?? null),
      eval: async (_script: string, _n: number, key: string, holder: string) => {
        const cur = store.get(key);
        if (cur === undefined) return null;
        if ((JSON.parse(cur) as { holder_user_id: string }).holder_user_id !== holder) return [0, cur];
        store.delete(key);
        return [1, cur];
      },
    };
    deps.leases = redisLeaseStore(() => redis as never, deps.clock.now);
    const lease = (userId: string) => JSON.stringify({ holder_user_id: userId, session_id: 's', expires_at: '2026-09-23T12:03:00.000Z' });

    store.set(leaseKey(app.id), lease(P.alice.userId));
    await as('ed', async (c) => expect(errorOf(await c.call('release_lease', { app_id: app.id })).code).toBe('app_locked'));
    expect(store.has(leaseKey(app.id))).toBe(true);
    expect(await audits(app.slug, 'app.lock.')).toEqual([]);

    store.set(leaseKey(app.id), lease(P.ed.userId));
    await as('ed', async (c) => expect(ok(await c.call('release_lease', { app_id: app.id }))).toMatchObject({ released: true }));
    expect(store.has(leaseKey(app.id))).toBe(false);
    expect(await audits(app.slug, 'app.lock.')).toEqual([
      { action: 'app.lock.release', actorKind: 'agent', actorUserId: P.ed.userId, meta: { previousHolderUserId: P.ed.userId, expiresAt: '2026-09-23T12:03:00.000Z' } },
    ]);
  });
});

describe('delete_app', () => {
  it('asks first, then deletes: gone from MCP, audited as the agent, the hosts told, the modules\' onAppDelete run', async () => {
    const app = await newApp({ published: true });
    const hooks: { hook: string; app: unknown }[] = [];
    const real = deps.modules;
    deps.modules = async () => {
      const rt = await real();
      const spied = Object.create(rt) as ModuleRuntime;
      spied.runHook = (async (hook: string, a: unknown) => {
        hooks.push({ hook, app: a });
      }) as ModuleRuntime['runHook'];
      return spied;
    };
    await as('ed', async (c) => {
      const ask = errorOf(await c.call('delete_app', { app_id: app.id }));
      expect(ask).toMatchObject({ code: 'user_confirmation_required', app_id: app.id, slug: app.slug, name: expect.stringMatching(/^Life \d+$/), published: true });
      expect(String(ask.message)).toContain(`https://${app.slug}.drobek.app`);
      expect(String(ask.message)).toMatch(/Ask the user whether to delete "Life \d+"/);
      expect((await row(app.id)).deletedAt).toBeNull();
      expect(hooks).toEqual([]);

      const out = ok(await c.call('delete_app', { app_id: app.id, user_confirmed: true }));
      expect(out).toMatchObject({ deleted: app.slug, app_id: app.id });
      const releaseAt = Date.parse(String(out.slug_released_at));
      expect(releaseAt - (await row(app.id)).deletedAt!.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
      expect(deps.events).toEqual([{ app_id: app.id, slug: app.slug, kind: 'delete' }]);
      expect(hooks).toEqual([{ hook: 'onAppDelete', app: { id: app.id, slug: app.slug, workspaceId: wsId } }]);

      expect(errorOf(await c.call('get_app', { app_id: app.id })).code).toBe('not_found');
      expect(errorOf(await c.call('delete_app', { app_id: app.id, user_confirmed: true })).code).toBe('not_found');
    });
    expect(await audits(app.slug, 'app.delete')).toEqual([expect.objectContaining({ action: 'app.delete', actorKind: 'agent', actorUserId: P.ed.userId })]);
  });

  it('a viewer gets forbidden, a non-member not_found; the app stays', async () => {
    const app = await newApp();
    await as('vera', async (c) => {
      expect(errorOf(await c.call('delete_app', { app_id: app.id, user_confirmed: true }))).toMatchObject({ code: 'forbidden' });
    });
    await as('eve', async (c) => {
      expect(errorOf(await c.call('delete_app', { app_id: app.id, user_confirmed: true }))).toMatchObject({ code: 'not_found' });
    });
    expect((await row(app.id)).deletedAt).toBeNull();
  });
});
