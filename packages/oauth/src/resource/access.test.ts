/**
 * M0-04: user-bound grants on a real (PGlite) database —
 *  - per-call membership authorization (member role, super-admin override,
 *    identical not_found for an unknown workspace / non-member / missing app);
 *  - list_apps across every workspace of the user (+ the workspace filter);
 *  - the RS Bearer path: audience check for OAuth tokens, `drk_` API keys,
 *    revoked key → invalid.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Request } from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { apps, memberships, users, workspaces } from '@drobek/db';
import { createApiKey, revokeApiKey } from '../api-keys.server.js';
import { issueAccessAndRefresh } from '../tokens.server.js';
import { freshDb, type TestDb } from '../test/db.js';
import { listAppsForPrincipal, listPrincipalWorkspaces, resolveCallWorkspace } from './access.js';
import { buildMcpServer } from './mcp.js';
import { authenticate, mcpResourceUri, type AuthContext } from './oauth-resource.js';

let db: TestDb;
let close: () => Promise<void>;
const ids: Record<string, string> = {};
const savedEnv = { ...process.env };

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const [alice] = await db.insert(users).values({ email: 'alice@example.test' }).returning();
  const [bob] = await db.insert(users).values({ email: 'bob@example.test' }).returning();
  const [root] = await db.insert(users).values({ email: 'root@example.test' }).returning();
  const [pa] = await db.insert(workspaces).values({ kind: 'personal', slug: 'alice', name: 'Alice' }).returning();
  const [team] = await db.insert(workspaces).values({ kind: 'team', slug: 'team-x', name: 'Team X' }).returning();
  const [pb] = await db.insert(workspaces).values({ kind: 'personal', slug: 'bob', name: 'Bob' }).returning();
  await db.insert(memberships).values([
    { userId: alice.id, workspaceId: pa.id, role: 'workspace-admin' },
    { userId: alice.id, workspaceId: team.id, role: 'viewer' },
    { userId: bob.id, workspaceId: pb.id, role: 'workspace-admin' },
  ]);
  await db.insert(apps).values([
    { workspaceId: pa.id, slug: 'alice-app' },
    { workspaceId: team.id, slug: 'team-app' },
    { workspaceId: pb.id, slug: 'bob-app' },
  ]);
  Object.assign(ids, { alice: alice.id, bob: bob.id, root: root.id, team: team.id });
});

afterEach(() => {
  process.env = { ...savedEnv };
});
afterAll(async () => close());

const alice = () => ({ userId: ids.alice, superAdmin: false });

describe('resolveCallWorkspace (per-call membership)', () => {
  it("resolves the caller's role in each of their workspaces", async () => {
    expect(await resolveCallWorkspace(alice(), 'alice')).toMatchObject({
      workspaceSlug: 'alice',
      role: 'workspace-admin',
    });
    expect(await resolveCallWorkspace(alice(), 'team-x')).toMatchObject({
      workspaceId: ids.team,
      role: 'viewer',
    });
  });

  it('answers a non-member and an unknown workspace identically (null → not_found)', async () => {
    expect(await resolveCallWorkspace(alice(), 'bob')).toBeNull();
    expect(await resolveCallWorkspace(alice(), 'no-such-workspace')).toBeNull();
    expect(await resolveCallWorkspace(alice(), '')).toBeNull();
  });

  it('lets the super-admin into any workspace as workspace-admin', async () => {
    const root = { userId: ids.root, superAdmin: true };
    expect(await resolveCallWorkspace(root, 'bob')).toMatchObject({ role: 'workspace-admin' });
    expect(await resolveCallWorkspace(root, 'no-such-workspace')).toBeNull();
  });
});

describe('whoami / list_apps across workspaces', () => {
  it('lists every workspace with the role', async () => {
    expect(await listPrincipalWorkspaces(alice())).toEqual([
      { slug: 'alice', name: 'Alice', kind: 'personal', role: 'workspace-admin' },
      { slug: 'team-x', name: 'Team X', kind: 'team', role: 'viewer' },
    ]);
  });

  it('lists apps from all of the user’s workspaces, never another user’s', async () => {
    const rows = (await listAppsForPrincipal(alice())) ?? [];
    expect(rows.map((r) => `${r.workspace}/${r.slug}`)).toEqual([
      'alice/alice-app',
      'team-x/team-app',
    ]);
  });

  it('filters by workspace, and a foreign/unknown workspace is null (not_found)', async () => {
    const rows = (await listAppsForPrincipal(alice(), 'team-x')) ?? [];
    expect(rows.map((r) => r.slug)).toEqual(['team-app']);
    expect(await listAppsForPrincipal(alice(), 'bob')).toBeNull();
    expect(await listAppsForPrincipal(alice(), 'nope')).toBeNull();
  });
});

function ctxFor(userId: string, email: string, superAdmin = false): AuthContext {
  return {
    kind: 'oauth',
    credentialId: 't',
    userId,
    email,
    superAdmin,
    scope: 'read write',
    scopes: ['read', 'write'],
    audience: 'http://localhost:3041/mcp',
  };
}

async function call(ctx: AuthContext, name: string, args: Record<string, unknown>) {
  const server = buildMcpServer(ctx);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(c);
  try {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[])[0].text;
    return { isError: Boolean(res.isError), body: text };
  } finally {
    await client.close();
  }
}

describe('MCP tools authorize per call (anti-enumeration)', () => {
  it('not_found is byte-identical for a foreign app, an unknown workspace and a missing app', async () => {
    const ctx = ctxFor(ids.alice, 'alice@example.test');
    const foreign = await call(ctx, 'app_errors', { workspace: 'bob', slug: 'bob-app' });
    const unknownWs = await call(ctx, 'app_errors', { workspace: 'nope', slug: 'bob-app' });
    const missing = await call(ctx, 'app_errors', { workspace: 'alice', slug: 'nope-app' });
    for (const r of [foreign, unknownWs, missing]) expect(r.isError).toBe(true);
    expect(foreign.body).toBe(missing.body);
    expect(unknownWs.body).toBe(missing.body);
    expect(JSON.parse(missing.body)).toEqual({ error: 'not_found', message: 'app not found' });
  });

  it('a viewer member reads, but cannot define a collection (editor+)', async () => {
    const ctx = ctxFor(ids.alice, 'alice@example.test');
    const read = await call(ctx, 'app_errors', { workspace: 'team-x', slug: 'team-app' });
    expect(read.isError).toBe(false);
    const define = await call(ctx, 'collection_define', {
      workspace: 'team-x',
      slug: 'team-app',
      name: 'todos',
      jsonSchema: { type: 'object' },
      accessMode: 'locked',
    });
    expect(define.isError).toBe(true);
    expect(JSON.parse(define.body).error).toBe('forbidden');
  });

  it('the super-admin reaches a workspace they are not a member of', async () => {
    const ctx = ctxFor(ids.root, 'root@example.test', true);
    const r = await call(ctx, 'app_errors', { workspace: 'bob', slug: 'bob-app' });
    expect(r.isError).toBe(false);
  });

  it('whoami returns the user and all their workspaces', async () => {
    const r = await call(ctxFor(ids.alice, 'alice@example.test'), 'whoami', {});
    const body = JSON.parse(r.body);
    expect(body.email).toBe('alice@example.test');
    expect(body.workspaces.map((w: { slug: string }) => w.slug)).toEqual(['alice', 'team-x']);
    expect(body.tools).toContain('record_create');
  });
});

function bearerReq(bearer: string): Request {
  return { headers: { authorization: `Bearer ${bearer}` } } as unknown as Request;
}

describe('authenticate (the RS Bearer path)', () => {
  it('accepts a token for this MCP resource and rejects one for another resource', async () => {
    process.env.PUBLIC_APP_URL = 'http://localhost:3041';
    delete process.env.PUBLIC_MCP_URL;
    const good = await issueAccessAndRefresh({
      userId: ids.alice,
      oauthClientId: null,
      scope: 'read',
      audience: mcpResourceUri(),
    });
    const other = await issueAccessAndRefresh({
      userId: ids.alice,
      oauthClientId: null,
      scope: 'read',
      audience: 'https://other.example/mcp',
    });
    const ok = await authenticate(bearerReq(good.accessToken));
    expect(ok.kind).toBe('ok');
    if (ok.kind === 'ok') {
      expect(ok.ctx).toMatchObject({ kind: 'oauth', userId: ids.alice, scopes: ['read'] });
    }
    expect((await authenticate(bearerReq(other.accessToken))).kind).toBe('invalid');
    expect((await authenticate({ headers: {} } as unknown as Request)).kind).toBe('no_token');
  });

  it('accepts a drk_ API key (no audience) until it is revoked', async () => {
    const key = await createApiKey({ userId: ids.bob, name: 'ci', scopes: ['read', 'write'] });
    const ok = await authenticate(bearerReq(key.key));
    expect(ok.kind).toBe('ok');
    if (ok.kind === 'ok') {
      expect(ok.ctx).toMatchObject({
        kind: 'api_key',
        userId: ids.bob,
        email: 'bob@example.test',
        scope: 'read write',
        audience: null,
      });
    }
    await revokeApiKey(key.id);
    expect((await authenticate(bearerReq(key.key))).kind).toBe('invalid');
    // A well-formed but unknown key is just invalid.
    expect((await authenticate(bearerReq(`drk_${'A'.repeat(32)}`))).kind).toBe('invalid');
  });

  it('marks a super-admin by email', async () => {
    process.env.SUPERADMIN_EMAIL = 'root@example.test';
    const key = await createApiKey({ userId: ids.root, name: 'ops', scopes: ['read'] });
    const r = await authenticate(bearerReq(key.key));
    expect(r.kind === 'ok' && r.ctx.superAdmin).toBe(true);
  });
});
