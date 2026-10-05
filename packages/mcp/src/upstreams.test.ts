/**
 * The proxy upstream tools over a real MCP client on a real (PGlite) database: the
 * upstream tools do what the dashboard's Upstreams page does, through the
 * same @drobek/proxy operations — list without secrets, register a keyless
 * upstream at once, answer a keyed one with the prefilled dashboard link (no
 * secret argument exists), refuse a duplicate and a bad base URL, register
 * with streaming and turn it on or off (set_upstream_streaming), remove only
 * with the user's explicit yes, the workspace-admin floor, and the audit rows
 * attributed to the agent.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apps, auditLog, memberships, setDbForTests, upstreamSecrets, upstreams, users, workspaces } from '@drobek/db';
import * as schema from '@drobek/db/schema';
import type { ModuleRuntime } from '@drobek/modules';
import { createUpstream, deleteUpstream, listUpstreams, type ConfigureActor } from '@drobek/proxy';
import type { ToolPrincipal } from './context.js';
import { freshDb, type TestDb } from './test/db.js';
import { connect, testDeps, type TestDeps } from './test/harness.js';

let db: TestDb;
let pg: Awaited<ReturnType<typeof freshDb>>['pg'];
let close: () => Promise<void>;
const P = {} as Record<'alice' | 'ed' | 'eve', ToolPrincipal>;
let wsId: string;
let deps: TestDeps;

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  pg = t.pg;
  close = () => t.pg.close();
  const mk = async (email: string) => (await db.insert(users).values({ email }).returning())[0].id;
  const ids = { alice: await mk('alice@example.test'), ed: await mk('ed@example.test'), eve: await mk('eve@example.test') };
  const [team] = await db.insert(workspaces).values({ kind: 'team', slug: 'team-u', name: 'Upstreams' }).returning();
  const [other] = await db.insert(workspaces).values({ kind: 'personal', slug: 'eve-u', name: 'Eve' }).returning();
  wsId = team.id;
  await db.insert(memberships).values([
    { userId: ids.alice, workspaceId: team.id, role: 'workspace-admin' },
    { userId: ids.ed, workspaceId: team.id, role: 'editor' },
    { userId: ids.eve, workspaceId: other.id, role: 'workspace-admin' },
  ]);
  for (const k of Object.keys(ids) as (keyof typeof ids)[]) P[k] = { userId: ids[k], email: `${k}@example.test`, superAdmin: false };
});
afterAll(async () => close());
beforeEach(() => {
  deps = testDeps();
});

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

const POKE = {
  workspace: 'team-u',
  name: 'pokeapi',
  base_url: 'https://pokeapi.co',
  allowed_methods: ['GET'],
  allowed_path_prefixes: ['/api/v2/'],
  auth_type: 'none',
};

describe('the proxy upstream tools', () => {
  it('register_upstream: a keyless upstream registers at once, audited as the agent; list_upstreams shows it; a duplicate is refused', async () => {
    await as('alice', async (c) => {
      const out = ok(await c.call('register_upstream', POKE));
      expect(out).toMatchObject({
        registered: true,
        upstream: {
          name: 'pokeapi',
          base_url: 'https://pokeapi.co',
          allowed_methods: ['GET'],
          allowed_path_prefixes: ['/api/v2'],
          auth_type: 'none',
          auth_header_name: null,
          has_secret: false,
          allow_streaming: false,
          apps: [],
        },
      });
      expect(String(out.next)).toContain("configure_module('proxy'");

      const [row] = await db.select().from(upstreams).where(eq(upstreams.name, 'pokeapi'));
      const audit = await db.select().from(auditLog).where(eq(auditLog.target, row.id));
      expect(audit.map((a) => [a.action, a.actorKind])).toEqual([['proxy.upstream.create', 'agent']]);

      const listed = ok(await c.call('list_upstreams', { workspace: 'team-u' }));
      expect(listed.workspace).toBe('team-u');
      expect(listed.upstreams_url).toBe('http://localhost:3041/workspaces/team-u/upstreams');
      expect((listed.upstreams as { name: string }[]).map((u) => u.name)).toEqual(['pokeapi']);

      expect(errorOf(await c.call('register_upstream', POKE))).toMatchObject({ code: 'upstream_already_registered' });
    });
  });

  it('a keyed upstream is not registered over MCP: the answer links the prefilled dashboard form, and no secret argument exists', async () => {
    await as('alice', async (c) => {
      const out = ok(
        await c.call('register_upstream', {
          ...POKE,
          name: 'weather',
          base_url: 'https://api.example.com',
          allowed_path_prefixes: ['/v1'],
          auth_type: 'header',
          auth_header_name: 'X-Api-Key',
        })
      );
      expect(out.registered).toBe(false);
      const url = new URL(String(out.secret_url));
      expect(url.pathname).toBe('/workspaces/team-u/upstreams');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        name: 'weather',
        baseUrl: 'https://api.example.com',
        methods: 'GET',
        paths: '/v1',
        authType: 'header',
        header: 'X-Api-Key',
      });
      expect(String(out.note)).toContain('Never ask for the key in chat');
      expect(await db.select().from(upstreams).where(eq(upstreams.name, 'weather'))).toHaveLength(0);

      const tools = (await c.client.listTools()).tools;
      const schema = tools.find((t) => t.name === 'register_upstream')!.inputSchema as { properties: Record<string, unknown> };
      expect(Object.keys(schema.properties)).not.toContain('secret');
    });
  });

  it('the same checks as the dashboard: a bad base URL or name is invalid_params and nothing is stored', async () => {
    await as('alice', async (c) => {
      expect(errorOf(await c.call('register_upstream', { ...POKE, name: 'bad-port', base_url: 'https://api.example.com:8080' }))).toMatchObject({
        code: 'invalid_params',
      });
      expect(errorOf(await c.call('register_upstream', { ...POKE, name: '9lives' }))).toMatchObject({ code: 'invalid_params' });
      expect(errorOf(await c.call('register_upstream', { ...POKE, name: 'hdr', auth_type: 'header' }))).toMatchObject({ code: 'invalid_params' });
    });
    expect((await db.select().from(upstreams)).map((u) => u.name)).toEqual(['pokeapi']);
  });

  it('workspace admins only: an editor gets forbidden, a non-member not_found', async () => {
    await as('ed', async (c) => {
      expect(errorOf(await c.call('list_upstreams', { workspace: 'team-u' }))).toMatchObject({ code: 'forbidden' });
      expect(errorOf(await c.call('register_upstream', { ...POKE, name: 'other' }))).toMatchObject({ code: 'forbidden' });
      expect(errorOf(await c.call('remove_upstream', { workspace: 'team-u', name: 'pokeapi', user_confirmed: true }))).toMatchObject({ code: 'forbidden' });
    });
    await as('eve', async (c) => {
      expect(errorOf(await c.call('list_upstreams', { workspace: 'team-u' }))).toMatchObject({ code: 'not_found' });
    });
  });

  it('remove_upstream: without the user\'s yes nothing changes and the apps using it are named; with it the upstream is gone', async () => {
    const [app] = await db.insert(apps).values({ workspaceId: wsId, slug: 'dex', name: 'Dex' }).returning();
    await db.update(upstreams).set({ allowedAppIds: [app.id] }).where(eq(upstreams.name, 'pokeapi'));
    await as('alice', async (c) => {
      expect((ok(await c.call('list_upstreams', { workspace: 'team-u' })).upstreams as { apps: string[] }[])[0].apps).toEqual(['dex']);
      expect(errorOf(await c.call('remove_upstream', { workspace: 'team-u', name: 'pokeapi' }))).toMatchObject({
        code: 'user_confirmation_required',
        name: 'pokeapi',
        apps: ['dex'],
      });
      expect(await db.select().from(upstreams).where(eq(upstreams.name, 'pokeapi'))).toHaveLength(1);

      expect(ok(await c.call('remove_upstream', { workspace: 'team-u', name: 'pokeapi', user_confirmed: true }))).toMatchObject({
        removed: 'pokeapi',
        apps: ['dex'],
      });
      expect(await db.select().from(upstreams).where(eq(upstreams.name, 'pokeapi'))).toHaveLength(0);
      expect(errorOf(await c.call('remove_upstream', { workspace: 'team-u', name: 'pokeapi', user_confirmed: true }))).toMatchObject({ code: 'not_found' });
    });
  });
});

describe('upstream caps (UPSTREAMS_MAX_PER_WORKSPACE, UPSTREAM_REGISTRATIONS_PER_HOUR)', () => {
  async function newWorkspace(slug: string): Promise<{ id: string; actor: ConfigureActor }> {
    const [ws] = await db.insert(workspaces).values({ kind: 'team', slug, name: slug }).returning();
    await db.insert(memberships).values({ userId: P.alice.userId, workspaceId: ws.id, role: 'workspace-admin' });
    return { id: ws.id, actor: { workspaceId: ws.id, actorUserId: P.alice.userId, role: 'workspace-admin' } };
  }

  function withPlan(limits: Record<string, number>): void {
    const real = deps.modules;
    deps.modules = async () => {
      const rt = await real();
      const planned = Object.create(rt) as ModuleRuntime;
      planned.workspaceLimits = async (id: string) => ({ ...(await rt.workspaceLimits(id)), ...limits });
      return planned;
    };
  }

  const feed = (workspace: string, region: string) => ({
    ...POKE,
    workspace,
    name: `feed-${region}`,
    base_url: `https://${region}.example.com`,
    allowed_path_prefixes: ['/rss'],
  });

  it('the workspace limit refuses the next upstream with limit_exceeded, keyed ones too; a taken name, deletes and existing upstreams over a lowered limit still work', async () => {
    const { id, actor } = await newWorkspace('caps-a');
    withPlan({ UPSTREAMS_MAX_PER_WORKSPACE: 2 });
    await as('alice', async (c) => {
      ok(await c.call('register_upstream', feed('caps-a', 'one')));
      ok(await c.call('register_upstream', feed('caps-a', 'two')));
      const over = errorOf(await c.call('register_upstream', feed('caps-a', 'three')));
      expect(over).toMatchObject({ code: 'limit_exceeded', limit: 'UPSTREAMS_MAX_PER_WORKSPACE', value: 2 });
      expect(String(over.message)).toContain('UPSTREAMS_MAX_PER_WORKSPACE');
      expect(String(over.hint)).toContain('register_upstream');
      // No dashboard link for a keyed upstream that could not be registered anyway.
      expect(errorOf(await c.call('register_upstream', { ...feed('caps-a', 'keyed'), auth_type: 'bearer' }))).toMatchObject({ code: 'limit_exceeded' });
      expect(errorOf(await c.call('register_upstream', feed('caps-a', 'one')))).toMatchObject({ code: 'upstream_already_registered' });
      ok(await c.call('remove_upstream', { workspace: 'caps-a', name: 'feed-two', user_confirmed: true }));
      ok(await c.call('register_upstream', feed('caps-a', 'three')));
    });
    // The dashboard path (the same operation) with a lowered limit: nothing is removed, delete works, no new one.
    const dashboard = { ...actor, name: 'feed-four', baseUrl: 'https://four.example.com', allowedMethods: ['GET'], allowedPathPrefixes: ['/rss'], authType: 'none' };
    await expect(createUpstream({ ...dashboard, maxUpstreams: 1 })).rejects.toMatchObject({
      code: 'limit_exceeded',
      details: { limit: 'UPSTREAMS_MAX_PER_WORKSPACE', value: 1 },
    });
    const listed = await listUpstreams(actor);
    expect(listed.map((u) => u.name)).toEqual(['feed-one', 'feed-three']);
    await deleteUpstream(actor, listed[0].id);
    await expect(createUpstream({ ...dashboard, maxUpstreams: 1 })).rejects.toMatchObject({ code: 'limit_exceeded' });
    expect((await db.select().from(upstreams).where(eq(upstreams.workspaceId, id))).map((u) => u.name)).toEqual(['feed-three']);
  });

  it('the env default is 20 upstreams per workspace', async () => {
    const { actor } = await newWorkspace('caps-default');
    const base = { ...actor, allowedMethods: ['GET'], allowedPathPrefixes: ['/'], authType: 'none', env: { UPSTREAM_REGISTRATIONS_PER_HOUR: '100' } };
    for (let i = 0; i < 20; i++) await createUpstream({ ...base, name: `u${i}`, baseUrl: `https://h${i}.example.com` });
    await expect(createUpstream({ ...base, name: 'u20', baseUrl: 'https://h20.example.com' })).rejects.toMatchObject({
      code: 'limit_exceeded',
      details: { limit: 'UPSTREAMS_MAX_PER_WORKSPACE', value: 20 },
    });
  });

  it('UPSTREAM_REGISTRATIONS_PER_HOUR: rate_limited with retry_after_seconds; a delete does not give the budget back; the next hour does', async () => {
    const { actor } = await newWorkspace('caps-rate');
    await newWorkspace('caps-rate-other');
    deps.env = { ...deps.env, UPSTREAM_REGISTRATIONS_PER_HOUR: '2' };
    await as('alice', async (c) => {
      ok(await c.call('register_upstream', feed('caps-rate', 'a')));
      ok(await c.call('register_upstream', feed('caps-rate', 'b')));
      ok(await c.call('remove_upstream', { workspace: 'caps-rate', name: 'feed-b', user_confirmed: true }));
      const limited = errorOf(await c.call('register_upstream', feed('caps-rate', 'c')));
      expect(limited).toMatchObject({ code: 'rate_limited', limit: 'UPSTREAM_REGISTRATIONS_PER_HOUR', value: 2 });
      expect(limited.retry_after_seconds).toBeGreaterThan(3500);
      expect(limited.retry_after_seconds).toBeLessThanOrEqual(3600);
      expect(String(limited.hint)).toContain('register_upstream');
      // Another workspace has its own budget.
      ok(await c.call('register_upstream', feed('caps-rate-other', 'a')));
    });
    const later = new Date(Date.now() + 61 * 60 * 1000);
    const view = await createUpstream({
      ...actor,
      name: 'feed-c',
      baseUrl: 'https://c.example.com',
      allowedMethods: ['GET'],
      allowedPathPrefixes: ['/rss'],
      authType: 'none',
      env: { UPSTREAM_REGISTRATIONS_PER_HOUR: '2' },
      now: () => later,
    });
    expect(view.name).toBe('feed-c');
  });

  it("listUpstreams reads only the workspace's own secret rows", async () => {
    const mine = await newWorkspace('secrets-mine');
    const theirs = await newWorkspace('secrets-theirs');
    const env = { UPSTREAM_REGISTRATIONS_PER_HOUR: '100' };
    const plain = { allowedMethods: ['GET'], allowedPathPrefixes: ['/'], authType: 'none', env };
    const a = await createUpstream({ ...mine.actor, ...plain, name: 'keyed', baseUrl: 'https://a.example.com' });
    await createUpstream({ ...mine.actor, ...plain, name: 'open', baseUrl: 'https://b.example.com' });
    const b = await createUpstream({ ...theirs.actor, ...plain, name: 'keyed', baseUrl: 'https://c.example.com' });
    const envelope = { ciphertext: 'x', iv: 'x', authTag: 'x', wrappedDek: 'x', kekId: 'k' };
    await db.insert(upstreamSecrets).values([{ upstreamId: a.id, ...envelope }, { upstreamId: b.id, ...envelope }]);

    const queries: { sql: string; params: unknown[] }[] = [];
    setDbForTests(drizzle(pg, { schema, logger: { logQuery: (q, params) => queries.push({ sql: q, params }) } }));
    try {
      expect((await listUpstreams(mine.actor)).map((u) => [u.name, u.hasSecret])).toEqual([
        ['keyed', true],
        ['open', false],
      ]);
    } finally {
      setDbForTests(db);
    }
    const secretReads = queries.filter((q) => q.sql.includes('from "upstream_secrets"'));
    expect(secretReads).toHaveLength(1);
    expect(secretReads[0].sql).toMatch(/where "upstream_secrets"\."upstream_id" in/);
    expect(secretReads[0].params).not.toContain(b.id);
  });
});

describe('streaming passthrough (allow_streaming, set_upstream_streaming)', () => {
  beforeAll(async () => {
    const [ws] = await db.insert(workspaces).values({ kind: 'team', slug: 'stream-u', name: 'Stream' }).returning();
    await db.insert(memberships).values([
      { userId: P.alice.userId, workspaceId: ws.id, role: 'workspace-admin' },
      { userId: P.ed.userId, workspaceId: ws.id, role: 'editor' },
    ]);
  });

  const LLM = {
    workspace: 'stream-u',
    name: 'llm',
    base_url: 'https://llm.example.com',
    allowed_methods: ['POST'],
    allowed_path_prefixes: ['/v1/'],
    auth_type: 'none',
  };

  it('register_upstream with allow_streaming: true stores it, lists it and names it in the audit row; without it the upstream is buffered', async () => {
    await as('alice', async (c) => {
      const out = ok(await c.call('register_upstream', { ...LLM, allow_streaming: true }));
      expect(out).toMatchObject({ registered: true, upstream: { name: 'llm', allow_streaming: true } });
      ok(await c.call('register_upstream', { ...LLM, name: 'plain', base_url: 'https://plain.example.com' }));
      const listed = ok(await c.call('list_upstreams', { workspace: 'stream-u' })).upstreams as { name: string; allow_streaming: boolean }[];
      expect(listed.map((u) => [u.name, u.allow_streaming])).toEqual([
        ['llm', true],
        ['plain', false],
      ]);
      const [row] = await db.select().from(upstreams).where(eq(upstreams.name, 'llm'));
      expect(row.allowStreaming).toBe(true);
      const [audit] = await db.select().from(auditLog).where(eq(auditLog.target, row.id));
      expect(audit.meta).toMatchObject({ name: 'llm', allowStreaming: true });
      const bad = await c.call('register_upstream', { ...LLM, name: 'bad', allow_streaming: 'yes' });
      expect(bad.isError).toBe(true);
      expect(await db.select().from(upstreams).where(eq(upstreams.name, 'bad'))).toHaveLength(0);
    });
  });

  it('a keyed upstream with allow_streaming carries streaming=1 in secret_url', async () => {
    await as('alice', async (c) => {
      const out = ok(await c.call('register_upstream', { ...LLM, name: 'keyed', auth_type: 'bearer', allow_streaming: true }));
      expect(new URL(String(out.secret_url)).searchParams.get('streaming')).toBe('1');
      const plain = ok(await c.call('register_upstream', { ...LLM, name: 'keyed', auth_type: 'bearer' }));
      expect(new URL(String(plain.secret_url)).searchParams.has('streaming')).toBe(false);
    });
  });

  it('set_upstream_streaming turns it on and off, audited as the agent; the same value again is changed: false with no row', async () => {
    await as('alice', async (c) => {
      const on = ok(await c.call('set_upstream_streaming', { workspace: 'stream-u', name: 'plain', allow_streaming: true }));
      expect(on).toMatchObject({ changed: true, upstream: { name: 'plain', allow_streaming: true } });
      expect(String(on.note)).toContain('PROXY_STREAM_MAX_MS');
      expect(ok(await c.call('set_upstream_streaming', { workspace: 'stream-u', name: 'plain', allow_streaming: true }))).toMatchObject({ changed: false });
      const off = ok(await c.call('set_upstream_streaming', { workspace: 'stream-u', name: 'plain', allow_streaming: false }));
      expect(off).toMatchObject({ changed: true, upstream: { allow_streaming: false } });
      const [row] = await db.select().from(upstreams).where(eq(upstreams.name, 'plain'));
      const updates = await db.select().from(auditLog).where(eq(auditLog.target, row.id));
      expect(updates.filter((a) => a.action === 'proxy.upstream.update').map((a) => [a.actorKind, a.meta])).toEqual([
        ['agent', { name: 'plain', allowStreaming: true }],
        ['agent', { name: 'plain', allowStreaming: false }],
      ]);
      expect(errorOf(await c.call('set_upstream_streaming', { workspace: 'stream-u', name: 'ghost', allow_streaming: true }))).toMatchObject({ code: 'not_found' });
    });
    await as('ed', async (c) => {
      expect(errorOf(await c.call('set_upstream_streaming', { workspace: 'stream-u', name: 'plain', allow_streaming: true }))).toMatchObject({ code: 'forbidden' });
    });
  });
});
