/**
 * NSO-372 over a real MCP client on a real (PGlite) database: the proxy
 * upstream tools do what the dashboard's Upstreams page does, through the
 * same @drobek/proxy operations — list without secrets, register a keyless
 * upstream at once, answer a keyed one with the prefilled dashboard link (no
 * secret argument exists), refuse a duplicate and a bad base URL, remove only
 * with the user's explicit yes, the workspace-admin floor, and the audit rows
 * attributed to the agent.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apps, auditLog, memberships, upstreams, users, workspaces } from '@drobek/db';
import type { ToolPrincipal } from './context.js';
import { freshDb, type TestDb } from './test/db.js';
import { connect, testDeps, type TestDeps } from './test/harness.js';

let db: TestDb;
let close: () => Promise<void>;
const P = {} as Record<'alice' | 'ed' | 'eve', ToolPrincipal>;
let wsId: string;
let deps: TestDeps;

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
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
