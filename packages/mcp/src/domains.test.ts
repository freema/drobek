/**
 * The custom-domain tools over a real MCP client on a real (PGlite) database: the
 * tools do what the dashboard's Domains tab does, through the same
 * @drobek/domains operations — list with the exact records, add (validation,
 * DOMAINS_MAX_PER_APP incl. 0, duplicates, a name another app verified),
 * verify against a mocked resolver (what is missing: CNAME vs TXT, a
 * transient failure, losing a verification), the primary domain and removal
 * only with the user's explicit yes where the public site changes, the role
 * floors (viewer lists, editor changes, a non-member sees not_found), a
 * taken-down app, and the audit rows attributed to the agent.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apps, auditLog, memberships, users, workspaces } from '@drobek/db';
import type { ModuleRuntime } from '@drobek/modules';
import type { ToolPrincipal } from './context.js';
import { freshDb, type TestDb } from './test/db.js';
import { connect, testDeps, type TestDeps } from './test/harness.js';

let db: TestDb;
let close: () => Promise<void>;
const P = {} as Record<'alice' | 'ed' | 'vera' | 'eve', ToolPrincipal>;
let wsId: string;
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
  const [team] = await db.insert(workspaces).values({ kind: 'team', slug: 'team-d', name: 'Domains' }).returning();
  const [other] = await db.insert(workspaces).values({ kind: 'personal', slug: 'eve-d', name: 'Eve' }).returning();
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
});

let n = 0;
async function newApp(): Promise<{ id: string; slug: string }> {
  n += 1;
  const [a] = await db.insert(apps).values({ workspaceId: wsId, slug: `shop-${n}`, name: `Shop ${n}` }).returning();
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

async function audits(hostname: string): Promise<{ action: string; actorKind: string }[]> {
  const rows = await db.select().from(auditLog).where(eq(auditLog.target, hostname)).orderBy(auditLog.createdAt);
  return rows.map((r) => ({ action: r.action, actorKind: r.actorKind }));
}

interface DomainOut {
  host: string;
  status: string;
  primary: boolean;
  records: { cname: { type: string; name: string; value: string }; txt: { type: string; name: string; value: string } };
  last_error: string | null;
  last_check_at: string | null;
  verified_at: string | null;
}

async function listed(c: Conn, appId: string): Promise<DomainOut[]> {
  return ok(await c.call('list_domains', { app_id: appId })).domains as DomainOut[];
}

/** Put both records of `host` into the zone (the value from the domain's records). */
function publishRecords(d: DomainOut, parts: { cname?: boolean; txt?: boolean } = { cname: true, txt: true }): void {
  if (parts.cname) deps.zone.cname[d.records.cname.name] = [d.records.cname.value];
  if (parts.txt) deps.zone.txt[d.records.txt.name] = [d.records.txt.value];
}

async function addVerified(c: Conn, appId: string, host: string): Promise<DomainOut> {
  const d = ok(await c.call('add_domain', { app_id: appId, host })).domain as DomainOut;
  publishRecords(d);
  return ok(await c.call('verify_domain', { app_id: appId, host })).domain as DomainOut;
}

describe('list_domains / add_domain', () => {
  it('an editor adds a domain and gets the exact two records; list_domains and get_app show it; audited as the agent', async () => {
    const app = await newApp();
    await as('ed', async (c) => {
      const empty = ok(await c.call('list_domains', { app_id: app.id }));
      expect(empty).toMatchObject({ app_id: app.id, cname_target: `${app.slug}.drobek.app`, max_per_app: 3, domains: [] });

      const added = ok(await c.call('add_domain', { app_id: app.id, host: 'https://Shop.Example.com/' }));
      const d = added.domain as DomainOut;
      expect(d).toMatchObject({
        host: 'shop.example.com',
        status: 'pending',
        primary: false,
        verified_at: null,
        last_check_at: null,
        last_error: null,
        records: {
          cname: { type: 'CNAME', name: 'shop.example.com', value: `${app.slug}.drobek.app` },
          txt: { type: 'TXT', name: '_drobek.shop.example.com' },
        },
      });
      expect(d.records.txt.value).toMatch(/^drobek-verify=[0-9a-f]{32}$/);
      expect(String(added.next)).toContain('verify_domain');
      expect(String(added.next)).toContain('48 hours');

      expect(await listed(c, app.id)).toEqual([expect.objectContaining({ host: 'shop.example.com', status: 'pending', records: d.records })]);
      expect(ok(await c.call('get_app', { app_id: app.id })).domains).toEqual([{ host: 'shop.example.com', status: 'pending', primary: false }]);
    });
    expect(await audits('shop.example.com')).toEqual([{ action: 'domain.add', actorKind: 'agent' }]);
  });

  it('refuses what the dashboard refuses: invalid names, drobek-owned names, duplicates, the limit', async () => {
    const app = await newApp();
    await as('alice', async (c) => {
      for (const bad of ['not a host', '10.0.0.1', 'shop.example.com:8080', '']) {
        expect(errorOf(await c.call('add_domain', { app_id: app.id, host: bad })), bad).toMatchObject({ code: 'invalid_hostname' });
      }
      for (const bad of ['x.drobek.app', 'co.uk', 'printer.local']) {
        const e = errorOf(await c.call('add_domain', { app_id: app.id, host: bad }));
        expect(e, bad).toMatchObject({ code: 'hostname_not_allowed' });
        expect(String(e.hint), bad).toMatch(/registrable domain/);
      }
      ok(await c.call('add_domain', { app_id: app.id, host: 'a.example.org' }));
      expect(errorOf(await c.call('add_domain', { app_id: app.id, host: 'A.example.org.' }))).toMatchObject({ code: 'domain_already_added' });
      ok(await c.call('add_domain', { app_id: app.id, host: 'b.example.org' }));
      ok(await c.call('add_domain', { app_id: app.id, host: 'c.example.org' }));
      const e = errorOf(await c.call('add_domain', { app_id: app.id, host: 'd.example.org' }));
      expect(e).toMatchObject({ code: 'limit_exceeded', limit: 'DOMAINS_MAX_PER_APP', value: 3 });
      expect(String(e.hint)).toContain('remove_domain');
      expect((await listed(c, app.id)).map((d) => d.host)).toEqual(['a.example.org', 'b.example.org', 'c.example.org']);
    });
  });

  it('DOMAINS_MAX_PER_APP 0 from the workspace limits: custom domains are off', async () => {
    const app = await newApp();
    const real = deps.modules;
    deps.modules = async () => {
      const rt = await real();
      const limited = Object.create(rt) as ModuleRuntime;
      limited.workspaceLimits = async (id: string) => ({ ...(await rt.workspaceLimits(id)), DOMAINS_MAX_PER_APP: 0 });
      return limited;
    };
    await as('alice', async (c) => {
      expect(ok(await c.call('list_domains', { app_id: app.id }))).toMatchObject({ max_per_app: 0, note: expect.stringContaining('off') });
      expect(errorOf(await c.call('add_domain', { app_id: app.id, host: 'off.example.org' }))).toMatchObject({
        code: 'limit_exceeded',
        limit: 'DOMAINS_MAX_PER_APP',
        value: 0,
      });
    });
  });

  it('a viewer lists but cannot change; a non-member sees not_found', async () => {
    const app = await newApp();
    await as('ed', async (c) => ok(await c.call('add_domain', { app_id: app.id, host: 'v.example.net' })));
    await as('vera', async (c) => {
      expect(await listed(c, app.id)).toHaveLength(1);
      for (const [tool, args] of [
        ['add_domain', { host: 'w.example.net' }],
        ['verify_domain', { host: 'v.example.net' }],
        ['set_primary_domain', { host: 'v.example.net', user_confirmed: true }],
        ['remove_domain', { host: 'v.example.net', user_confirmed: true }],
      ] as const) {
        expect(errorOf(await c.call(tool, { app_id: app.id, ...args })), tool).toMatchObject({ code: 'forbidden' });
      }
    });
    await as('eve', async (c) => {
      expect(errorOf(await c.call('list_domains', { app_id: app.id }))).toMatchObject({ code: 'not_found' });
      expect(errorOf(await c.call('add_domain', { app_id: app.id, host: 'x.example.net' }))).toMatchObject({ code: 'not_found' });
    });
  });
});

describe('verify_domain', () => {
  it('says which record is missing, stores the check, verifies once both exist, audited domain.verify', async () => {
    const app = await newApp();
    await as('ed', async (c) => {
      const d = ok(await c.call('add_domain', { app_id: app.id, host: 'www.example.com' })).domain as DomainOut;

      const none = errorOf(await c.call('verify_domain', { app_id: app.id, host: 'www.example.com' }));
      expect(none).toMatchObject({ code: 'domain_not_verified', host: 'www.example.com', cname: 'missing', txt: 'missing', records: d.records });
      expect(String(none.message)).toContain(`CNAME www.example.com → ${app.slug}.drobek.app: not found`);
      expect(String(none.message)).toContain('TXT _drobek.www.example.com');
      expect(String(none.message)).toContain('48 hours');
      expect(String(none.hint)).toMatch(/verify_domain again/);

      publishRecords(d, { txt: true });
      const onlyTxt = errorOf(await c.call('verify_domain', { app_id: app.id, host: 'www.example.com' }));
      expect(onlyTxt).toMatchObject({ code: 'domain_not_verified', cname: 'missing', txt: 'ok' });
      expect(String(onlyTxt.message)).toContain('CNAME www.example.com');
      expect(String(onlyTxt.message)).not.toContain('TXT _drobek');
      const [stored] = await listed(c, app.id);
      expect(stored.status).toBe('pending');
      expect(stored.last_error).toContain('CNAME');
      expect(stored.last_check_at).not.toBeNull();

      deps.zone.cname['www.example.com'] = ['elsewhere.example.net'];
      expect(errorOf(await c.call('verify_domain', { app_id: app.id, host: 'www.example.com' }))).toMatchObject({ cname: 'wrong', txt: 'ok' });

      publishRecords(d);
      const v = ok(await c.call('verify_domain', { app_id: app.id, host: 'WWW.example.com' }));
      expect(v).toMatchObject({ newly_verified: true, domain: { host: 'www.example.com', status: 'verified', last_error: null } });
      expect(String(v.note)).toContain('once the app is published');
      expect((v.domain as DomainOut).verified_at).not.toBeNull();
      expect(ok(await c.call('verify_domain', { app_id: app.id, host: 'www.example.com' }))).toMatchObject({ newly_verified: false });
    });
    expect(await audits('www.example.com')).toEqual([
      { action: 'domain.add', actorKind: 'agent' },
      { action: 'domain.verify', actorKind: 'agent' },
    ]);
  });

  it('a lookup failure is dns_unavailable and changes nothing; records gone later drop the verification', async () => {
    const app = await newApp();
    await as('ed', async (c) => {
      const d = await addVerified(c, app.id, 'blog.example.com');
      deps.zone.fail.add('_drobek.blog.example.com');
      deps.zone.fail.add('blog.example.com');
      const t = errorOf(await c.call('verify_domain', { app_id: app.id, host: 'blog.example.com' }));
      expect(t).toMatchObject({ code: 'dns_unavailable', cname: 'unavailable', txt: 'unavailable' });
      expect(String(t.message)).toContain('Nothing changed');
      expect((await listed(c, app.id))[0].status).toBe('verified');

      deps.zone.fail.clear();
      delete deps.zone.txt[d.records.txt.name];
      const lost = errorOf(await c.call('verify_domain', { app_id: app.id, host: 'blog.example.com' }));
      expect(lost).toMatchObject({ code: 'domain_not_verified', txt: 'missing', cname: 'ok', unverified: true });
      expect(String(lost.message)).toContain('lost its verification');
      expect((await listed(c, app.id))[0].status).toBe('pending');
    });
    expect((await audits('blog.example.com')).map((a) => a.action)).toEqual(['domain.add', 'domain.verify', 'domain.unverify']);
  });

  it('an unknown host is not_found; a name verified for another app is domain_taken', async () => {
    const a = await newApp();
    const b = await newApp();
    await as('alice', async (c) => {
      expect(errorOf(await c.call('verify_domain', { app_id: a.id, host: 'nope.example.com' }))).toMatchObject({ code: 'not_found' });
      await addVerified(c, a.id, 'taken.example.com');
      expect(errorOf(await c.call('add_domain', { app_id: b.id, host: 'taken.example.com' }))).toMatchObject({ code: 'domain_taken' });
    });
  });
});

describe('set_primary_domain', () => {
  it('needs a verified domain and the user\'s explicit yes; sets and clears; audited domain.primary', async () => {
    const app = await newApp();
    await as('ed', async (c) => {
      ok(await c.call('add_domain', { app_id: app.id, host: 'pending.example.com' }));
      expect(errorOf(await c.call('set_primary_domain', { app_id: app.id, host: 'pending.example.com', user_confirmed: true }))).toMatchObject({
        code: 'domain_not_verified',
      });
      expect(errorOf(await c.call('set_primary_domain', { app_id: app.id, host: 'missing.example.com', user_confirmed: true }))).toMatchObject({
        code: 'not_found',
      });

      await addVerified(c, app.id, 'main.example.com');
      const ask = errorOf(await c.call('set_primary_domain', { app_id: app.id, host: 'main.example.com' }));
      expect(ask).toMatchObject({ code: 'user_confirmation_required', host: 'main.example.com', current_primary: null });
      expect(String(ask.message)).toContain(`${app.slug}.drobek.app`);
      expect((await listed(c, app.id)).find((d) => d.host === 'main.example.com')?.primary).toBe(false);

      expect(ok(await c.call('set_primary_domain', { app_id: app.id, host: 'main.example.com', user_confirmed: true }))).toMatchObject({
        primary: 'main.example.com',
        previous_primary: null,
      });
      expect((await listed(c, app.id)).find((d) => d.host === 'main.example.com')?.primary).toBe(true);
      expect(ok(await c.call('get_app', { app_id: app.id })).domains).toContainEqual({ host: 'main.example.com', status: 'verified', primary: true });

      const clear = errorOf(await c.call('set_primary_domain', { app_id: app.id, host: null }));
      expect(clear).toMatchObject({ code: 'user_confirmation_required', host: null, current_primary: 'main.example.com' });
      expect(ok(await c.call('set_primary_domain', { app_id: app.id, host: null, user_confirmed: true }))).toMatchObject({
        primary: null,
        previous_primary: 'main.example.com',
      });
      expect((await listed(c, app.id)).every((d) => !d.primary)).toBe(true);
    });
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, wsId), eq(auditLog.action, 'domain.primary')));
    const mine = rows.filter((r) => (r.meta as { app_id?: string }).app_id === app.id);
    expect(mine.map((r) => [r.target, r.actorKind])).toEqual([
      ['main.example.com', 'agent'],
      ['', 'agent'],
    ]);
  });
});

describe('remove_domain', () => {
  it('a pending domain goes at once; a verified one only with the user\'s yes; audited domain.remove', async () => {
    const app = await newApp();
    await as('ed', async (c) => {
      ok(await c.call('add_domain', { app_id: app.id, host: 'draft.example.com' }));
      expect(ok(await c.call('remove_domain', { app_id: app.id, host: 'draft.example.com' }))).toMatchObject({
        removed: 'draft.example.com',
        was_verified: false,
        was_primary: false,
      });

      await addVerified(c, app.id, 'live.example.com');
      ok(await c.call('set_primary_domain', { app_id: app.id, host: 'live.example.com', user_confirmed: true }));
      const ask = errorOf(await c.call('remove_domain', { app_id: app.id, host: 'live.example.com' }));
      expect(ask).toMatchObject({ code: 'user_confirmation_required', host: 'live.example.com', primary: true });
      expect(await listed(c, app.id)).toHaveLength(1);

      expect(ok(await c.call('remove_domain', { app_id: app.id, host: 'live.example.com', user_confirmed: true }))).toMatchObject({
        removed: 'live.example.com',
        was_verified: true,
        was_primary: true,
      });
      expect(await listed(c, app.id)).toEqual([]);
      expect(errorOf(await c.call('remove_domain', { app_id: app.id, host: 'live.example.com', user_confirmed: true }))).toMatchObject({
        code: 'not_found',
      });
    });
    expect((await audits('draft.example.com')).map((a) => a.action)).toEqual(['domain.add', 'domain.remove']);
    expect((await audits('live.example.com')).map((a) => a.action)).toEqual(['domain.add', 'domain.verify', 'domain.primary', 'domain.remove']);
  });
});

describe('a taken-down app', () => {
  it('refuses adding, verifying and a primary domain; removing stays possible', async () => {
    const app = await newApp();
    await as('ed', async (c) => ok(await c.call('add_domain', { app_id: app.id, host: 'down.example.com' })));
    await db.update(apps).set({ lockedReason: 'phishing' }).where(eq(apps.id, app.id));
    await as('ed', async (c) => {
      for (const [tool, args] of [
        ['add_domain', { host: 'more.example.com' }],
        ['verify_domain', { host: 'down.example.com' }],
        ['set_primary_domain', { host: 'down.example.com', user_confirmed: true }],
      ] as const) {
        expect(errorOf(await c.call(tool, { app_id: app.id, ...args })), tool).toMatchObject({ code: 'app_locked_by_admin', reason: 'phishing' });
      }
      expect(ok(await c.call('list_domains', { app_id: app.id })).domains).toHaveLength(1);
      ok(await c.call('remove_domain', { app_id: app.id, host: 'down.example.com' }));
    });
  });
});
