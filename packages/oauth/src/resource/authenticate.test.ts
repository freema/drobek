/**
 * M0-04/M0-05: user-bound grants on a real (PGlite) database —
 *  - the RS Bearer path: audience check for OAuth tokens, `drk_` API keys,
 *    revoked key → invalid, super-admin by email;
 *  - the MCP server this package builds authorizes every tool call per app
 *    (the bodies live in @drobek/mcp; this is the wiring check): identical
 *    not_found for a foreign / missing app, viewer cannot write, super-admin
 *    override.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Request } from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { noopLogger } from '@drobek/core';
import { apps, memberships, users, workspaces } from '@drobek/db';
import { memoryLeaseStore } from '@drobek/mcp';
import { createApiKey, revokeApiKey } from '../api-keys.server.js';
import { issueAccessAndRefresh } from '../tokens.server.js';
import { freshDb, type TestDb } from '../test/db.js';
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
  const [teamApp] = await db.insert(apps).values({ workspaceId: team.id, slug: 'team-app' }).returning();
  const [bobApp] = await db.insert(apps).values({ workspaceId: pb.id, slug: 'bob-app' }).returning();
  Object.assign(ids, {
    alice: alice.id,
    bob: bob.id,
    root: root.id,
    teamApp: teamApp.id,
    bobApp: bobApp.id,
  });
});

afterEach(() => {
  process.env = { ...savedEnv };
});
afterAll(async () => close());

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
  const server = buildMcpServer(ctx, {
    leases: memoryLeaseStore(),
    notifyAppChanged: async () => {},
    env: { APPS_DOMAIN: 'drobek.app' },
    log: noopLogger,
  });
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
  it('not_found is byte-identical for a foreign app and a missing app', async () => {
    const ctx = ctxFor(ids.alice, 'alice@example.test');
    const foreign = await call(ctx, 'get_app', { app_id: ids.bobApp });
    const missing = await call(ctx, 'get_app', { app_id: 'no-such-app' });
    for (const r of [foreign, missing]) expect(r.isError).toBe(true);
    expect(foreign.body).toBe(missing.body);
    expect(JSON.parse(missing.body)).toMatchObject({ code: 'not_found', message: 'app not found' });
    expect(JSON.parse(missing.body).hint).toBeTruthy();
  });

  it('a viewer member reads, but cannot write (editor+)', async () => {
    const ctx = ctxFor(ids.alice, 'alice@example.test');
    const read = await call(ctx, 'get_app', { app_id: ids.teamApp });
    expect(read.isError, read.body).toBe(false);
    expect(JSON.parse(read.body)).toMatchObject({ slug: 'team-app', workspace: 'team-x', latest_version: 0 });
    const write = await call(ctx, 'write_files', {
      app_id: ids.teamApp,
      files: [{ path: 'index.html', content: '<h1>x</h1>' }],
      reasoning: 'x',
    });
    expect(write.isError).toBe(true);
    expect(JSON.parse(write.body).code).toBe('forbidden');
  });

  it('the super-admin reaches a workspace they are not a member of', async () => {
    const ctx = ctxFor(ids.root, 'root@example.test', true);
    const r = await call(ctx, 'get_app', { app_id: ids.bobApp });
    expect(r.isError).toBe(false);
  });

  it('list_apps returns the user and all their workspaces', async () => {
    const r = await call(ctxFor(ids.alice, 'alice@example.test'), 'list_apps', {});
    const body = JSON.parse(r.body);
    expect(body.user).toEqual({ email: 'alice@example.test' });
    expect(body.workspaces.map((w: { slug: string }) => w.slug)).toEqual(['alice', 'team-x']);
    expect(body.apps.map((a: { slug: string }) => a.slug)).toEqual(['team-app']);
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
