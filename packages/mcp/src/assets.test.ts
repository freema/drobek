/**
 * NSO-358 asset tools over a real MCP client on a real (PGlite) database:
 * create_asset_upload hands out a single-use upload URL on the dashboard host
 * (bound to app + path + size + the caller), the PUT on it stores the file
 * as the caller (audit), list_assets / delete_asset, the role floor, the
 * refusals with their catalogue hints, the hourly budget and a takedown.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { errorHint } from '@drobek/agent-dx';
import { consumeUploadToken, createAssetUploadHandler, hashUploadToken } from '@drobek/apps';
import { apps, auditLog, memberships, users, workspaces } from '@drobek/db';
import type { ToolPrincipal } from './context.js';
import { freshDb, type TestDb } from './test/db.js';
import { connect, testDeps, type TestDeps } from './test/harness.js';

let db: TestDb;
let close: () => Promise<void>;
const P = {} as Record<'alice' | 'vera' | 'eve', ToolPrincipal>;
let deps: TestDeps;

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const mk = async (email: string) => (await db.insert(users).values({ email }).returning())[0].id;
  const alice = await mk('alice@example.test');
  const vera = await mk('vera@example.test');
  const eve = await mk('eve@example.test');
  const [team] = await db.insert(workspaces).values({ kind: 'team', slug: 'team-m', name: 'Media' }).returning();
  const [pe] = await db.insert(workspaces).values({ kind: 'personal', slug: 'eve-m', name: 'Eve' }).returning();
  await db.insert(memberships).values([
    { userId: alice, workspaceId: team.id, role: 'workspace-admin' },
    { userId: vera, workspaceId: team.id, role: 'viewer' },
    { userId: eve, workspaceId: pe.id, role: 'workspace-admin' },
  ]);
  P.alice = { userId: alice, email: 'alice@example.test', superAdmin: false };
  P.vera = { userId: vera, email: 'vera@example.test', superAdmin: false };
  P.eve = { userId: eve, email: 'eve@example.test', superAdmin: false };
});
afterAll(async () => close());
beforeEach(() => {
  deps = testDeps();
});

/** An MP4 of `size` bytes: an ftyp box with the isom brand, then filler. */
function fakeMp4(size: number): Buffer {
  const head = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom\0\0\x02\0isomiso2avc1mp41', 'latin1')]);
  return Buffer.concat([head, Buffer.alloc(size - head.length, 7)]);
}

async function newApp(name: string, template: 'html' | 'react-ts' = 'html') {
  const c = await connect(P.alice, deps);
  try {
    const r = await c.call('create_app', { name, workspace: 'team-m', template });
    expect(r.isError, r.text).toBe(false);
    return r.body as { app_id: string; slug: string };
  } finally {
    await c.close();
  }
}

async function call(who: keyof typeof P, name: string, args: Record<string, unknown>) {
  const c = await connect(P[who], deps);
  try {
    return await c.call(name, args);
  } finally {
    await c.close();
  }
}

/** The upload endpoint as apps/server mounts it, over the test deps' token store and disk. */
async function uploadServer(): Promise<{ base: string; server: Server }> {
  const handler = createAssetUploadHandler({
    limits: async () => ({ maxBytes: 100 * 1024 * 1024, quota: 1024 * 1024 * 1024 }),
    hint: errorHint,
    tokens: deps.assets.tokens,
    disk: deps.assets.disk,
    now: deps.clock.now,
  });
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

describe('create_asset_upload → PUT → list_assets → delete_asset', () => {
  it('hands out a single-use URL on the dashboard host; the PUT stores the file as the caller', async () => {
    const app = await newApp('Family film');
    const r = await call('alice', 'create_asset_upload', { app_id: app.app_id, path: 'film.mp4', size: 4096, content_type: 'video/mp4' });
    expect(r.isError, r.text).toBe(false);
    const body = r.body as Record<string, string | number>;
    expect(body.upload_url).toMatch(/^https:\/\/dash\.drobek\.test\/api\/assets\/upload\/[A-Za-z0-9_-]{43}$/);
    expect(body).toMatchObject({
      method: 'PUT',
      max_bytes: 100 * 1024 * 1024,
      asset_path: '/film.mp4',
      asset_url: `https://${app.slug}--preview.drobek.app/film.mp4`,
      curl: `curl -T <file> '${body.upload_url}'`,
    });
    expect(Date.parse(String(body.expires_at)) - deps.clock.now()).toBe(30 * 60 * 1000);

    // Only the hash is stored; the grant is bound to the app, path, size and caller.
    const token = String(body.upload_url).split('/').pop()!;
    expect(await deps.uploadTokens.peek(token)).toBeNull();
    expect(await deps.uploadTokens.peek(hashUploadToken(token))).toMatchObject({
      appId: app.app_id,
      name: 'film.mp4',
      size: 4096,
      contentType: 'video/mp4',
      userId: P.alice.userId,
      actorKind: 'agent',
      via: 'mcp',
    });

    const { base, server } = await uploadServer();
    try {
      const url = String(body.upload_url).replace('https://dash.drobek.test', base);
      const put = await fetch(url, { method: 'PUT', body: new Uint8Array(fakeMp4(4096)) });
      expect(put.status).toBe(201);
      expect(await put.json()).toMatchObject({ path: '/film.mp4', size: 4096, type: 'video/mp4', replaced: false });
      // Single use: the same URL again is upload_token_invalid.
      const again = await fetch(url, { method: 'PUT', body: new Uint8Array(fakeMp4(4096)) });
      expect(again.status).toBe(404);
      expect(await again.json()).toMatchObject({ code: 'upload_token_invalid', hint: errorHint('upload_token_invalid') });
    } finally {
      server.close();
    }

    const [audit] = await db
      .select({ actorUserId: auditLog.actorUserId, actorKind: auditLog.actorKind, meta: auditLog.meta })
      .from(auditLog)
      .where(and(eq(auditLog.action, 'asset.upload'), eq(auditLog.target, app.slug)));
    expect(audit).toMatchObject({ actorUserId: P.alice.userId, actorKind: 'agent', meta: { name: 'film.mp4', size: 4096, via: 'mcp' } });

    const listed = await call('vera', 'list_assets', { app_id: app.app_id });
    expect(listed.isError, listed.text).toBe(false);
    expect(listed.body).toMatchObject({
      app_id: app.app_id,
      assets: [{ path: '/film.mp4', type: 'video/mp4', size: 4096, published: false }],
      published_only: [],
      changes_pending_publish: true,
      used_bytes: 4096,
      quota_bytes: 1024 * 1024 * 1024,
    });

    expect((await call('vera', 'delete_asset', { app_id: app.app_id, path: 'film.mp4' })).body.code).toBe('forbidden');
    const del = await call('alice', 'delete_asset', { app_id: app.app_id, path: '/film.mp4' });
    expect(del.body).toMatchObject({ deleted: '/film.mp4' });
    expect(String(del.body.note)).toContain('next publish');
    const gone = await call('alice', 'delete_asset', { app_id: app.app_id, path: 'film.mp4' });
    expect(gone.body).toMatchObject({ code: 'asset_not_found', path: '/film.mp4', hint: errorHint('asset_not_found') });
    expect((await call('alice', 'list_assets', { app_id: app.app_id })).body).toMatchObject({ assets: [], used_bytes: 0 });
  });

  it('a nested path like the page uses (img/s1.jpg) is fine', async () => {
    const app = await newApp('Chapters');
    const r = await call('alice', 'create_asset_upload', { app_id: app.app_id, path: 'img/s1.jpg', size: 2000 });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.asset_path).toBe('/img/s1.jpg');
  });
});

describe('refusals, before any URL exists', () => {
  it('each with its code and the catalogue hint', async () => {
    const app = await newApp('Refusals');
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ path: 'film.mp4', size: 101 * 1024 * 1024 }, 'asset_too_large'],
      [{ path: 'film.mp4', size: 1000, content_type: 'text/html' }, 'asset_type_not_allowed'],
      [{ path: 'page.html', size: 1000 }, 'invalid_params'],
      [{ path: '../film.mp4', size: 1000 }, 'invalid_params'],
      [{ path: 'film.mp4', size: 0 }, 'invalid_params'],
      [{ path: 'film.mp4', size: 1.5 }, 'invalid_params'],
    ];
    for (const [args, code] of cases) {
      const r = await call('alice', 'create_asset_upload', { app_id: app.app_id, ...args });
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.body.code, JSON.stringify(args)).toBe(code);
      expect(r.body.hint).toBe(errorHint(code));
    }
    expect(deps.uploadTokens.size()).toBe(0);
  });

  it('a path an app file occupies is asset_path_taken', async () => {
    const app = await newApp('Taken');
    const c = await connect(P.alice, deps);
    try {
      const w = await c.call('write_files', {
        app_id: app.app_id,
        files: [{ path: 'img/logo.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"/>' }],
        reasoning: 'a logo',
      });
      expect(w.isError, w.text).toBe(false);
    } finally {
      await c.close();
    }
    const r = await call('alice', 'create_asset_upload', { app_id: app.app_id, path: 'img/logo.svg', size: 100 });
    expect(r.body).toMatchObject({ code: 'asset_path_taken', path: '/img/logo.svg', hint: errorHint('asset_path_taken') });
  });

  it('roles: a viewer may list but not upload; a non-member gets not_found', async () => {
    const app = await newApp('Roles');
    expect((await call('vera', 'create_asset_upload', { app_id: app.app_id, path: 'a.png', size: 10 })).body.code).toBe('forbidden');
    expect((await call('eve', 'create_asset_upload', { app_id: app.app_id, path: 'a.png', size: 10 })).body.code).toBe('not_found');
    expect((await call('eve', 'list_assets', { app_id: app.app_id })).body.code).toBe('not_found');
    expect((await call('eve', 'delete_asset', { app_id: app.app_id, path: 'a.png' })).body.code).toBe('not_found');
  });

  it('the hourly budget of upload URLs answers rate_limited', async () => {
    const app = await newApp('Budget');
    deps.uploadBudget.left = 1;
    expect((await call('alice', 'create_asset_upload', { app_id: app.app_id, path: 'a.png', size: 10 })).isError).toBe(false);
    const r = await call('alice', 'create_asset_upload', { app_id: app.app_id, path: 'b.png', size: 10 });
    expect(r.body).toMatchObject({ code: 'rate_limited', limit: 'APP_ASSET_UPLOADS_PER_HOUR', hint: errorHint('rate_limited') });
  });

  it('a taken-down app refuses upload URLs and deletes, but still lists', async () => {
    const app = await newApp('Down');
    await db.update(apps).set({ lockedReason: 'malware' }).where(eq(apps.id, app.app_id));
    expect((await call('alice', 'create_asset_upload', { app_id: app.app_id, path: 'a.png', size: 10 })).body.code).toBe('app_locked_by_admin');
    expect((await call('alice', 'delete_asset', { app_id: app.app_id, path: 'a.png' })).body.code).toBe('app_locked_by_admin');
    expect((await call('alice', 'list_assets', { app_id: app.app_id })).isError).toBe(false);
  });

  it('an expired URL is gone', async () => {
    const app = await newApp('Expiry');
    const r = await call('alice', 'create_asset_upload', { app_id: app.app_id, path: 'a.png', size: 10 });
    const token = String(r.body.upload_url).split('/').pop()!;
    deps.clock.advance(30 * 60 * 1000 + 1);
    expect(await consumeUploadToken(deps.assets.tokens, token, deps.clock.now)).toBeNull();
  });
});
