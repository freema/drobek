import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appAssets, apps, auditLog, users, workspaces } from '@drobek/db';
import {
  AssetDisk,
  AssetsError,
  assetUploadAllowed,
  checkAssetUpload,
  consumeUploadToken,
  createApp,
  createAssetUploadHandler,
  createUploadToken,
  createVersion,
  deleteAsset,
  findServedAsset,
  listAssets,
  memoryUploadTokenStore,
  peekUploadToken,
  storeAsset,
  sweepAssets,
  type Actor,
  type AssetApp,
  type AssetLimits,
  type UploadGrant,
} from '../index.js';
import { freshDb, type TestDb } from '../test/db.js';
import { chunks, fakeMp4 } from '../test/assets.js';

let db: TestDb;
let close: () => Promise<void>;
let wsId: string;
let userId: string;
let actor: Actor;
let root: string;
let disk: AssetDisk;
const LIMITS: AssetLimits = { maxBytes: 64 * 1024, quota: 100 * 1024 };

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const [u] = await db.insert(users).values({ email: 'assets@example.test' }).returning();
  const [w] = await db.insert(workspaces).values({ kind: 'personal', slug: 'assets', name: 'Assets' }).returning();
  wsId = w.id;
  userId = u.id;
  actor = { userId: u.id, kind: 'agent' };
  root = mkdtempSync(join(tmpdir(), 'drobek-assets-'));
  disk = new AssetDisk(root);
});
afterAll(async () => {
  await close();
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
async function newApp(): Promise<AssetApp> {
  n += 1;
  const a = await createApp({ workspaceId: wsId, slug: `media-${n}`, actor });
  return { id: a.id, slug: a.slug, workspaceId: wsId };
}

async function refusal(p: Promise<unknown>): Promise<AssetsError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AssetsError) return err;
    throw err;
  }
  throw new Error('expected an AssetsError');
}

const tmpLeft = () => (existsSync(disk.tmpDir) ? readdirSync(disk.tmpDir) : []);
const filesOf = (appId: string) => (existsSync(join(root, appId)) ? readdirSync(join(root, appId)) : []);

async function audits(slug: string) {
  return db
    .select({ action: auditLog.action, meta: auditLog.meta, actorKind: auditLog.actorKind, actorUserId: auditLog.actorUserId })
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, wsId), eq(auditLog.target, slug)))
    .orderBy(auditLog.createdAt);
}

describe('storeAsset — streamed, sniffed, capped, audited', () => {
  it('stores an MP4: row + file on disk + audit; listed and served by name', async () => {
    const app = await newApp();
    const bytes = fakeMp4(5000);
    const out = await storeAsset({ app, name: 'film.mp4', body: chunks(bytes), size: bytes.length, contentType: 'video/mp4', limits: LIMITS, actor, via: 'mcp', disk });
    expect(out).toMatchObject({ name: 'film.mp4', path: '/film.mp4', size: 5000, type: 'video/mp4', replaced: false });
    const served = await findServedAsset(app.id, 'film.mp4');
    expect(served).toMatchObject({ contentType: 'video/mp4', size: 5000, sha256: out.sha256 });
    expect(filesOf(app.id)).toEqual([served!.storageKey]);
    expect((await listAssets(app.id)).map((a) => [a.name, a.path, a.type, a.size])).toEqual([['film.mp4', '/film.mp4', 'video/mp4', 5000]]);
    const a = await audits(app.slug);
    expect(a.at(-1)).toMatchObject({ action: 'asset.upload', actorKind: 'agent', actorUserId: userId, meta: { name: 'film.mp4', size: 5000, type: 'video/mp4', via: 'mcp', replaced: false } });
    expect(tmpLeft()).toEqual([]);
  });

  it('a range read streams only those bytes', async () => {
    const app = await newApp();
    const bytes = fakeMp4(3000, 9);
    await storeAsset({ app, name: 'a.mp4', body: chunks(bytes), size: bytes.length, limits: LIMITS, actor, via: 'mcp', disk });
    const row = (await findServedAsset(app.id, 'a.mp4'))!;
    const stream = (await disk.open(app.id, row.storageKey, { start: 0, end: 99 }))!;
    const got: Buffer[] = [];
    for await (const c of stream) got.push(c as Buffer);
    expect(Buffer.concat(got)).toEqual(bytes.subarray(0, 100));
  });

  it('replacing a name writes a new file and removes the old one', async () => {
    const app = await newApp();
    await storeAsset({ app, name: 'clip.mp4', body: chunks(fakeMp4(2000)), size: 2000, limits: LIMITS, actor, via: 'mcp', disk });
    const first = (await findServedAsset(app.id, 'clip.mp4'))!.storageKey;
    const out = await storeAsset({ app, name: 'clip.mp4', body: chunks(fakeMp4(2500, 3)), size: 2500, limits: LIMITS, actor, via: 'dashboard', disk });
    expect(out.replaced).toBe(true);
    const second = (await findServedAsset(app.id, 'clip.mp4'))!;
    expect(second.storageKey).not.toBe(first);
    expect(second.size).toBe(2500);
    expect(filesOf(app.id)).toEqual([second.storageKey]);
  });

  it('an HTML page named .mp4 is asset_type_not_allowed — nothing stored, no temp file', async () => {
    const app = await newApp();
    const html = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>');
    const e = await refusal(storeAsset({ app, name: 'film.mp4', body: chunks(html), size: html.length, limits: LIMITS, actor, via: 'mcp', disk }));
    expect(e.code).toBe('asset_type_not_allowed');
    expect(e.status).toBe(415);
    expect(await findServedAsset(app.id, 'film.mp4')).toBeNull();
    expect(tmpLeft()).toEqual([]);
  });

  it('bytes of another allowed type than the name holds are refused (a PNG named .mp3)', async () => {
    const app = await newApp();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)]);
    const e = await refusal(storeAsset({ app, name: 'song.mp3', body: chunks(png), size: png.length, limits: LIMITS, actor, via: 'mcp', disk }));
    expect(e.code).toBe('asset_type_not_allowed');
    expect(e.details.type).toBe('image/png');
  });

  it('over APP_ASSET_MAX_BYTES while streaming: stops at once (the rest is never read)', async () => {
    const app = await newApp();
    let pulled = 0;
    async function* endless(): AsyncGenerator<Buffer> {
      yield fakeMp4(1024);
      for (;;) {
        pulled += 1;
        yield Buffer.alloc(1024, 1);
      }
    }
    const e = await refusal(storeAsset({ app, name: 'big.mp4', body: endless(), size: null, limits: LIMITS, actor, via: 'mcp', disk }));
    expect(e.code).toBe('asset_too_large');
    expect(e.details).toEqual({ limit: 'APP_ASSET_MAX_BYTES', value: LIMITS.maxBytes });
    expect(pulled).toBeLessThanOrEqual(LIMITS.maxBytes / 1024);
    expect(tmpLeft()).toEqual([]);
    // A declared size over the limit is refused before a byte is read.
    const early = await refusal(storeAsset({ app, name: 'big.mp4', body: endless(), size: LIMITS.maxBytes + 1, limits: LIMITS, actor, via: 'mcp', disk }));
    expect(early.code).toBe('asset_too_large');
  });

  it('a body longer or shorter than the declared size is asset_size_mismatch', async () => {
    const app = await newApp();
    const long = await refusal(storeAsset({ app, name: 'x.mp4', body: chunks(fakeMp4(3000)), size: 2000, limits: LIMITS, actor, via: 'mcp', disk }));
    expect(long.code).toBe('asset_size_mismatch');
    const short = await refusal(storeAsset({ app, name: 'x.mp4', body: chunks(fakeMp4(1000)), size: 2000, limits: LIMITS, actor, via: 'mcp', disk }));
    expect(short.code).toBe('asset_size_mismatch');
    expect(tmpLeft()).toEqual([]);
  });

  it('APP_ASSETS_QUOTA: refused up front and against the real size; a replaced asset does not count twice', async () => {
    const app = await newApp();
    const quota: AssetLimits = { maxBytes: 64 * 1024, quota: 10_000 };
    await storeAsset({ app, name: 'one.mp4', body: chunks(fakeMp4(6000)), size: 6000, limits: quota, actor, via: 'mcp', disk });
    const e = await refusal(checkAssetUpload({ appId: app.id, name: 'two.mp4', size: 5000, limits: quota }));
    expect(e.code).toBe('asset_quota_exceeded');
    expect(e.details).toMatchObject({ limit: 'APP_ASSETS_QUOTA', value: 10_000, used_bytes: 6000 });
    const streamed = await refusal(storeAsset({ app, name: 'two.mp4', body: chunks(fakeMp4(5000)), size: null, limits: quota, actor, via: 'mcp', disk }));
    expect(streamed.code).toBe('asset_quota_exceeded');
    expect(filesOf(app.id)).toHaveLength(1);
    // Replacing one.mp4 with 9 000 bytes fits: its own 6 000 are not counted.
    await checkAssetUpload({ appId: app.id, name: 'one.mp4', size: 9000, limits: quota });
    await storeAsset({ app, name: 'one.mp4', body: chunks(fakeMp4(9000)), size: 9000, limits: quota, actor, via: 'mcp', disk });
  });

  it('a taken-down or deleted app refuses the upload and keeps nothing', async () => {
    const locked = await newApp();
    await db.update(apps).set({ lockedReason: 'phishing' }).where(eq(apps.id, locked.id));
    const e = await refusal(storeAsset({ app: locked, name: 'x.mp4', body: chunks(fakeMp4(1000)), size: 1000, limits: LIMITS, actor, via: 'mcp', disk }));
    expect(e.code).toBe('app_locked_by_admin');
    expect(filesOf(locked.id)).toEqual([]);
    const gone = await newApp();
    await db.update(apps).set({ deletedAt: new Date() }).where(eq(apps.id, gone.id));
    expect((await refusal(storeAsset({ app: gone, name: 'x.mp4', body: chunks(fakeMp4(1000)), size: 1000, limits: LIMITS, actor, via: 'mcp', disk }))).code).toBe('not_found');
  });

  it('an asset may sit in a folder; a path an app file occupies (latest or published version) is asset_path_taken', async () => {
    const app = await newApp();
    const nested = await storeAsset({ app, name: 'media/Film-1.mp4', body: chunks(fakeMp4(1200)), size: 1200, limits: LIMITS, actor, via: 'mcp', disk });
    expect(nested.path).toBe('/media/Film-1.mp4');
    expect(await findServedAsset(app.id, 'media/Film-1.mp4')).not.toBeNull();
    await createVersion(app.id, [{ path: 'index.html', content: '<video src="film.mp4">' }, { path: 'img/logo.svg', content: '<svg/>' }], { actor });
    const taken = await refusal(checkAssetUpload({ appId: app.id, name: 'img/logo.svg', size: 10, limits: LIMITS }));
    expect(taken.code).toBe('asset_path_taken');
    expect(taken.status).toBe(409);
    expect(taken.details).toEqual({ path: '/img/logo.svg' });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect((await refusal(storeAsset({ app, name: 'img/logo.svg', body: chunks(svg), size: null, limits: LIMITS, actor, via: 'mcp', disk }))).code).toBe(
      'asset_path_taken'
    );
    await checkAssetUpload({ appId: app.id, name: 'film.mp4', size: 10, limits: LIMITS });
  });

  it('deleteAsset removes the row and the file and audits it; a second delete is false', async () => {
    const app = await newApp();
    await storeAsset({ app, name: 'bye.mp4', body: chunks(fakeMp4(1500)), size: 1500, limits: LIMITS, actor, via: 'mcp', disk });
    expect(await deleteAsset({ app, name: 'bye.mp4', actor: { userId, kind: 'user' }, via: 'dashboard', disk })).toBe(true);
    expect(await findServedAsset(app.id, 'bye.mp4')).toBeNull();
    expect(filesOf(app.id)).toEqual([]);
    expect((await audits(app.slug)).at(-1)).toMatchObject({ action: 'asset.delete', actorKind: 'user', meta: { name: 'bye.mp4', size: 1500, via: 'dashboard' } });
    expect(await deleteAsset({ app, name: 'bye.mp4', actor, via: 'mcp', disk })).toBe(false);
  });
});

describe('upload tokens — single use, expiring, bound to one asset', () => {
  const grant = (app: AssetApp, over: Partial<UploadGrant> = {}): Omit<UploadGrant, 'expiresAt'> => ({
    appId: app.id,
    appSlug: app.slug,
    workspaceId: app.workspaceId,
    name: 'film.mp4',
    size: 4096,
    contentType: 'video/mp4',
    userId,
    actorKind: 'agent',
    via: 'mcp',
    ...over,
  });

  it('a token is taken exactly once; only its hash is stored', async () => {
    const app = await newApp();
    const store = memoryUploadTokenStore();
    const { token, expiresAt } = await createUploadToken(store, grant(app));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 60 * 1000);
    expect(await peekUploadToken(store, token)).toMatchObject({ appId: app.id, name: 'film.mp4', size: 4096 });
    expect(await consumeUploadToken(store, token)).toMatchObject({ appId: app.id, name: 'film.mp4', size: 4096, contentType: 'video/mp4', userId });
    expect(await consumeUploadToken(store, token)).toBeNull();
    expect(await peekUploadToken(store, token)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it('expires after 30 minutes; malformed tokens are never looked up', async () => {
    const app = await newApp();
    let now = Date.now();
    const store = memoryUploadTokenStore(() => now);
    const { token } = await createUploadToken(store, grant(app), () => now);
    now += 30 * 60 * 1000 + 1;
    expect(await consumeUploadToken(store, token, () => now)).toBeNull();
    for (const bad of ['', 'short', `${'a'.repeat(42)}/`, 'x'.repeat(200)]) expect(await consumeUploadToken(store, bad)).toBeNull();
  });

  it('the per-app upload URL budget (APP_ASSET_UPLOADS_PER_HOUR)', async () => {
    const counts = new Map<string, number>();
    const counter = async (appId: string, limit: number) => {
      const c = (counts.get(appId) ?? 0) + 1;
      counts.set(appId, c);
      return c <= limit;
    };
    const env = { APP_ASSET_UPLOADS_PER_HOUR: '2' };
    expect(await assetUploadAllowed('a1', { counter, env })).toBe(true);
    expect(await assetUploadAllowed('a1', { counter, env })).toBe(true);
    expect(await assetUploadAllowed('a1', { counter, env })).toBe(false);
    expect(await assetUploadAllowed('a2', { counter, env })).toBe(true);
  });
});

describe('the upload URL endpoint (PUT /api/assets/upload/<token>)', () => {
  let server: Server;
  let base: string;
  const store = memoryUploadTokenStore();

  beforeAll(async () => {
    const handler = createAssetUploadHandler({
      limits: async () => LIMITS,
      hint: (code) => `hint:${code}`,
      tokens: store,
      disk,
      assetUrl: (slug, path) => `http://${slug}--preview.apps.test${path}`,
    });
    server = createServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/assets/upload/`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function mint(app: AssetApp, over: Partial<UploadGrant> = {}): Promise<string> {
    const { token } = await createUploadToken(store, {
      appId: app.id,
      appSlug: app.slug,
      workspaceId: app.workspaceId,
      name: 'film.mp4',
      size: 4096,
      contentType: '',
      userId,
      actorKind: 'agent',
      via: 'mcp',
      ...over,
    });
    return token;
  }

  it('curl -T equivalent: 201 with the path, served type and URL; the link then answers 404', async () => {
    const app = await newApp();
    const token = await mint(app);
    const r = await fetch(`${base}${token}`, { method: 'PUT', body: new Uint8Array(fakeMp4(4096)) });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ name: 'film.mp4', path: '/film.mp4', size: 4096, type: 'video/mp4', replaced: false, url: `http://${app.slug}--preview.apps.test/film.mp4` });
    const again = await fetch(`${base}${token}`, { method: 'PUT', body: new Uint8Array(fakeMp4(4096)) });
    expect(again.status).toBe(404);
    expect(await again.json()).toMatchObject({ code: 'upload_token_invalid', hint: 'hint:upload_token_invalid' });
    expect(await findServedAsset(app.id, 'film.mp4')).not.toBeNull();
  });

  it('a Content-Length other than the bound size is refused before reading (400) and burns the link', async () => {
    const app = await newApp();
    const token = await mint(app);
    const r = await fetch(`${base}${token}`, { method: 'PUT', body: new Uint8Array(fakeMp4(5000)) });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ code: 'asset_size_mismatch', declared: 4096 });
    expect((await fetch(`${base}${token}`, { method: 'PUT', body: new Uint8Array(fakeMp4(4096)) })).status).toBe(404);
  });

  it('bytes of the wrong type: 415 asset_type_not_allowed with the catalogue hint', async () => {
    const app = await newApp();
    const token = await mint(app, { size: 100 });
    const r = await fetch(`${base}${token}`, { method: 'PUT', body: new Uint8Array(Buffer.from('<html>'.padEnd(100, ' '))) });
    expect(r.status).toBe(415);
    expect(await r.json()).toMatchObject({ code: 'asset_type_not_allowed', hint: 'hint:asset_type_not_allowed' });
  });

  it('GET shows the browser upload page (own strict CSP, no token in the page) without using the link', async () => {
    const app = await newApp();
    const token = await mint(app);
    const page = await fetch(`${base}${token}`);
    expect(page.status).toBe(200);
    const csp = page.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/default-src 'none'/);
    expect(csp).toMatch(/connect-src 'self'/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    const html = await page.text();
    expect(html).toContain('film.mp4');
    expect(html).not.toContain(token);
    expect((await fetch(`${base}${token}`, { method: 'PUT', body: new Uint8Array(fakeMp4(4096)) })).status).toBe(201);
    expect((await fetch(`${base}${token}`)).status).toBe(404);
  });

  it('other methods: 405', async () => {
    const r = await fetch(`${base}whatever`, { method: 'POST', body: 'x' });
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('GET, HEAD, PUT');
  });
});

describe('sweepAssets', () => {
  it("removes a deleted app's assets after the retention, stale temp uploads and unreferenced files", async () => {
    const kept = await newApp();
    const gone = await newApp();
    await storeAsset({ app: kept, name: 'k.mp4', body: chunks(fakeMp4(1000)), size: 1000, limits: LIMITS, actor, via: 'mcp', disk });
    await storeAsset({ app: gone, name: 'g.mp4', body: chunks(fakeMp4(1000)), size: 1000, limits: LIMITS, actor, via: 'mcp', disk });
    const now = new Date();
    await db.update(apps).set({ deletedAt: new Date(now.getTime() - 25 * 60 * 60 * 1000) }).where(eq(apps.id, gone.id));
    const old = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    writeFileSync(join(disk.tmpDir, 'stale.part'), 'x');
    utimesSync(join(disk.tmpDir, 'stale.part'), old, old);
    writeFileSync(join(disk.tmpDir, 'fresh.part'), 'x');
    const orphan = join(root, kept.id, 'f'.repeat(32));
    writeFileSync(orphan, 'x');
    utimesSync(orphan, old, old);

    const out = await sweepAssets({ disk, now });
    expect(out.apps).toBe(1);
    expect(out.tmp).toBe(1);
    expect(out.orphans).toBe(1);
    expect(await db.select().from(appAssets).where(eq(appAssets.appId, gone.id))).toEqual([]);
    expect(existsSync(join(root, gone.id))).toBe(false);
    expect(existsSync(join(disk.tmpDir, 'fresh.part'))).toBe(true);
    expect(filesOf(kept.id)).toEqual([(await findServedAsset(kept.id, 'k.mp4'))!.storageKey]);
  });
});
