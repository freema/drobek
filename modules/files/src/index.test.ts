/**
 * The files module under createModuleTestContext(): real routes through the
 * production pipeline (CSRF, rules, the streamed multipart body), PGlite with
 * the core + files migrations, and a temporary FILES_DIR on disk.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apps, workspaces, type DB } from '@drobek/db';
import * as schema from '@drobek/db/schema';
import { buildSdk, isDefinedModule, loadModules, type Principal } from '@drobek/modules';
import { createModuleTestContext, type ModuleTestContext, type TestResponse } from '@drobek/modules/testing';
import auth from 'drobek-module-auth';
import filesModule, { FILES_CONFIG_DEFAULTS, blobStore, cleanName, files, filesAuthority, filesConfigSchema, filesConfirmRequired, type FilesConfig } from './index.js';

const CORE_MIGRATIONS = fileURLToPath(new URL('../../../packages/db/drizzle/migrations', import.meta.url));
const MiB = 1024 * 1024;

let pg: PGlite;
let db: DB;
let dir: string;
let workspaceId: string;
let appA: string;
let appB: string;

const ANON: Principal = { kind: 'anon' };
const ANA: Principal = { kind: 'user', id: 'eu_ana', email: 'ana@example.com', role: 'user' };
const BOB: Principal = { kind: 'user', id: 'eu_bob', email: 'bob@example.com', role: 'user' };
const ADMIN: Principal = { kind: 'user', id: 'eu_boss', email: 'boss@example.com', role: 'admin' };

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (bytes: number) => Buffer.concat([PNG_SIG, randomBytes(Math.max(0, bytes - PNG_SIG.length))]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>');
const CSV = Buffer.from('name,city\r\nAna,Brno\r\n');
const HTML = Buffer.from('<!doctype html><html><body><script>fetch("/__drobek/v1/files")</script></body></html>');

const BOUNDARY = '----drobekFilesTest4f2a';

function form(content: Buffer, opts: { filename?: string; type?: string; field?: string } = {}) {
  const head =
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${opts.field ?? 'file'}"; filename="${opts.filename ?? 'photo.png'}"\r\n` +
    `Content-Type: ${opts.type ?? 'image/png'}\r\n\r\n`;
  return {
    rawBody: Buffer.concat([Buffer.from(head), content, Buffer.from(`\r\n--${BOUNDARY}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  };
}

/** Every regular file under FILES_DIR (blobs and temp files). */
function onDisk(): { blobs: string[]; tmp: string[] } {
  if (!existsSync(dir)) return { blobs: [], tmp: [] };
  const all = (readdirSync(dir, { recursive: true }) as string[]).filter((p) => statSync(join(dir, p)).isFile());
  return { blobs: all.filter((p) => !p.startsWith('tmp')), tmp: all.filter((p) => p.startsWith('tmp')) };
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'drobek-files-'));
  process.env.FILES_DIR = dir;
  pg = new PGlite();
  const d = drizzle(pg, { schema });
  await migrate(d, { migrationsFolder: CORE_MIGRATIONS, migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
  await migrate(d, { migrationsFolder: filesModule.migrations!.folder, migrationsTable: '__drizzle_migrations_mod_files', migrationsSchema: 'drizzle' });
  const [ws] = await d.insert(workspaces).values({ kind: 'team', slug: 'files-ws', name: 'Files' }).returning();
  workspaceId = ws.id;
  appA = (await d.insert(apps).values({ workspaceId, slug: 'album', name: 'Album' }).returning())[0].id;
  appB = (await d.insert(apps).values({ workspaceId, slug: 'other', name: 'Other' }).returning())[0].id;
  db = d as unknown as DB;
});

afterAll(async () => {
  await pg.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.FILES_DIR;
});

beforeEach(async () => {
  await db.delete(files);
  rmSync(dir, { recursive: true, force: true });
});

function ctx(opts: { principal?: Principal; config?: Record<string, unknown>; limits?: Record<string, number>; app?: string } = {}): ModuleTestContext {
  const id = opts.app ?? appA;
  const slug = id === appA ? 'album' : 'other';
  return createModuleTestContext(filesModule, {
    db,
    app: { id, slug, workspaceId },
    config: opts.config ?? {},
    limits: opts.limits,
    principal: opts.principal ?? ANA,
    origin: `http://${slug}--preview.apps.localhost`,
  });
}

type Stored = { id: string; url: string; size: number; type: string; name: string; owner: string | null; created_at: string };

async function upload(t: ModuleTestContext, content: Buffer, opts: Parameters<typeof form>[1] & { chunkSize?: number } = {}): Promise<TestResponse> {
  const f = form(content, opts);
  return t.request('POST', '/', { rawBody: f.rawBody, headers: f.headers, chunkSize: opts.chunkSize });
}

async function stored(t: ModuleTestContext, content: Buffer, opts: Parameters<typeof upload>[2] = {}): Promise<Stored> {
  const r = await upload(t, content, opts);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as Stored;
}

describe('the module', () => {
  it('is a valid module; the SDK exposes drobek.files', async () => {
    expect(isDefinedModule(filesModule)).toBe(true);
    const importer = async (pkg: string) => ({ 'drobek-module-auth': { default: auth }, 'drobek-module-files': { default: filesModule } })[pkg];
    expect((await loadModules({ DROBEK_MODULES: 'auth,files' }, { importer })).map((m) => m.name)).toEqual(['auth', 'files']);
    const sdk = await buildSdk([auth, filesModule]);
    expect(sdk.dts).toContain('readonly files: files.Api;');
    expect(sdk.dts).toContain('upload(file: Blob');
    expect(sdk.js.toString('utf8')).toContain('FormData');
  });

  it("the skill's React example (uploads behind <LoginGate>) compiles; the skill stays ≤ 150 lines", async () => {
    const { compile } = await import('@drobek/compile');
    const sdk = await buildSdk([auth, filesModule]);
    const example = /```tsx\n([\s\S]*?)```/.exec(filesModule.skill.markdown)![1];
    const r = await compile(
      new Map([
        [
          'drobek.json',
          JSON.stringify({
            imports: {
              react: 'https://esm.sh/react@19.1.0',
              'react/jsx-runtime': 'https://esm.sh/react@19.1.0/jsx-runtime',
              'react-dom': 'https://esm.sh/react-dom@19.1.0?deps=react@19.1.0',
              'react-dom/client': 'https://esm.sh/react-dom@19.1.0/client?deps=react@19.1.0',
            },
          }),
        ],
        ['src/main.tsx', example],
        ['src/styles.css', 'body { margin: 0; }'],
      ]),
      { sdkUrl: sdk.url, sdkSources: sdk.inline }
    );
    expect(r.errors).toEqual([]);
    expect(r.outputs.get('main.js')!.toString('utf8')).toContain('function LoginGate(');
    expect(filesModule.skill.markdown.split('\n').length).toBeLessThanOrEqual(150);
  });
});

describe('config', () => {
  it('defaults: signed-in users upload and read; images, PDF and CSV', () => {
    expect(filesConfigSchema.parse({})).toEqual({ rules: { upload: 'user', read: 'user' }, allowedTypes: ['image/*', 'application/pdf', 'text/csv'] });
    expect(filesConfigSchema.parse(FILES_CONFIG_DEFAULTS)).toEqual(FILES_CONFIG_DEFAULTS);
  });

  it('refuses unknown rules, types, keys and a non-positive maxBytes', () => {
    for (const bad of [
      { rules: { read: 'everyone' } },
      { rules: { delete: 'user' } },
      { allowedTypes: ['text/html'] },
      { allowedTypes: [] },
      { maxBytes: 0 },
      { maxBytes: 1.5 },
      { visibility: 'public' },
    ]) {
      expect(filesConfigSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('confirmRequired: upload → public always; read → public only while the app holds files', async () => {
    const parse = (c: unknown) => filesConfigSchema.parse(c) as FilesConfig;
    const context = (app: string) => ({ app: { id: app, slug: 'x', workspaceId }, db });
    const before = parse({});
    expect(await filesConfirmRequired(before, parse({ rules: { upload: 'public' } }), context(appA))).toEqual([
      'files.rules.upload: "user" → "public" (anyone, signed in or not, may upload files into the app\'s storage)',
    ]);
    expect(await filesConfirmRequired(before, parse({ rules: { read: 'public' } }), context(appA))).toEqual([]);
    expect(await filesConfirmRequired(before, parse({ rules: { read: 'owner|admin' }, maxBytes: 1000 }), context(appA))).toEqual([]);
    await stored(ctx(), png(100));
    expect(await filesConfirmRequired(before, parse({ rules: { read: 'public' } }), context(appA))).toEqual([
      'files.rules.read: "user" → "public" (anyone with a link may download all 1 stored file and every future one)',
    ]);
    expect(await filesConfirmRequired(before, parse({ rules: { read: 'public' } }), context(appB))).toEqual([]);
    expect(await filesConfirmRequired(parse({ rules: { read: 'public' } }), parse({ rules: { read: 'public|user' } }), context(appA))).toEqual([]);
  });
});

describe('upload + download', () => {
  it('stores a PNG at its content address and serves it with nosniff, inline, ETag; 304 on If-None-Match', async () => {
    const t = ctx();
    const bytes = png(5000);
    const f = await stored(t, bytes, { filename: '../../My cat.png', type: 'application/octet-stream', chunkSize: 1000 });
    expect(f).toMatchObject({ url: `/__drobek/v1/files/${f.id}`, size: 5000, type: 'image/png', name: 'My cat.png', owner: 'eu_ana' });
    expect(cleanName('C:\\fakepath\\a"b\u0007.png')).toBe('ab.png');
    const h = sha(bytes);
    expect(onDisk()).toEqual({ blobs: [join(h.slice(0, 2), h.slice(2, 4), h)], tmp: [] });
    expect(t.audits).toEqual([{ action: 'files.upload', meta: { id: f.id, size: 5000, type: 'image/png' } }]);

    const got = await t.request('GET', `/${f.id}`);
    expect(got.status).toBe(200);
    expect(got.bytes.equals(bytes)).toBe(true);
    expect(got.headers).toMatchObject({
      'Content-Type': 'image/png',
      'Content-Length': '5000',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="My cat.png"; filename*=UTF-8''My%20cat.png`,
      ETag: `"${h}"`,
      'Cache-Control': 'private, no-cache',
    });
    const cached = await t.request('GET', `/${f.id}`, { headers: { 'if-none-match': `W/"${h}"` } });
    expect(cached.status).toBe(304);
    expect(cached.bytes.length).toBe(0);
    const head = await t.request('HEAD', `/${f.id}`);
    expect(head.status).toBe(200);
    expect(head.headers['Content-Length']).toBe('5000');
  });

  it('acceptance: 10 MiB + 1 B → 413 while streaming — no row, nothing on disk; exactly 10 MiB is stored', async () => {
    const t = ctx();
    const over = await upload(t, png(10 * MiB + 1));
    expect(over.status).toBe(413);
    expect(over.body).toMatchObject({ error: 'payload_too_large', details: { limit: 'FILES_MAX_BYTES', value: 10 * MiB }, hint: "skill_info('files')" });
    expect(onDisk()).toEqual({ blobs: [], tmp: [] });
    expect(await db.select().from(files)).toEqual([]);

    // A much larger body is cut off near the cap: the rest is never read.
    const huge = await upload(t, png(30 * MiB));
    expect(huge.status).toBe(413);
    expect(huge.bodyBytesRead).toBeLessThan(11 * MiB);
    expect(onDisk()).toEqual({ blobs: [], tmp: [] });

    // A declared Content-Length over the cap is refused before anything is read.
    const f = form(png(100));
    const declared = await t.request('POST', '/', { rawBody: f.rawBody, headers: { ...f.headers, 'content-length': String(50 * MiB) } });
    expect(declared.status).toBe(413);
    expect(declared.bodyBytesRead).toBe(0);

    expect((await upload(t, png(10 * MiB))).status).toBe(201);
    expect(onDisk().tmp).toEqual([]);
  });

  it("the app's maxBytes lowers the cap (details.limit maxBytes); FILES_MAX_BYTES wins when smaller", async () => {
    const lowered = await upload(ctx({ config: { maxBytes: 1000 } }), png(1001));
    expect(lowered.status).toBe(413);
    expect(lowered.body).toMatchObject({ details: { limit: 'maxBytes', value: 1000 } });
    const operator = await upload(ctx({ config: { maxBytes: 5000 }, limits: { FILES_MAX_BYTES: 2000 } }), png(2001));
    expect(operator.body).toMatchObject({ error: 'payload_too_large', details: { limit: 'FILES_MAX_BYTES', value: 2000 } });
  });

  it('acceptance: a .png holding HTML → 415 unsupported_type, nothing stored; types outside allowedTypes → 415', async () => {
    const r = await upload(ctx(), HTML, { filename: 'cute-cat.png', type: 'image/png' });
    expect(r.status).toBe(415);
    expect(r.body).toMatchObject({ error: 'unsupported_type', details: { allowed: ['image/*', 'application/pdf', 'text/csv'] }, hint: "skill_info('files')" });
    expect(onDisk()).toEqual({ blobs: [], tmp: [] });
    expect(await db.select().from(files)).toEqual([]);

    const exe = await upload(ctx(), Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200_000)]), { filename: 'a.pdf', type: 'application/pdf', chunkSize: 4096 });
    expect(exe.status).toBe(415);
    expect(exe.bodyBytesRead).toBeLessThan(20_000); // refused on the first chunks

    const pdfOnly = await upload(ctx({ config: { allowedTypes: ['application/pdf'] } }), png(100));
    expect(pdfOnly.status).toBe(415);
    expect(pdfOnly.body).toMatchObject({ details: { type: 'image/png', allowed: ['application/pdf'] } });
    expect((await upload(ctx({ config: { allowedTypes: ['application/pdf'] } }), PDF, { filename: 'x.pdf' })).status).toBe(201);
    expect(onDisk().tmp).toEqual([]);
  });

  it('acceptance: SVG is served as an attachment; CSV too (UTF-8); PDF inline', async () => {
    const t = ctx();
    const svg = await stored(t, SVG, { filename: 'logo.svg', type: 'image/svg+xml' });
    expect(svg.type).toBe('image/svg+xml');
    const s = await t.request('GET', `/${svg.id}`);
    expect(s.headers).toMatchObject({ 'Content-Type': 'image/svg+xml', 'X-Content-Type-Options': 'nosniff' });
    expect(s.headers['Content-Disposition']).toMatch(/^attachment; filename="logo\.svg"/);

    const csv = await stored(t, CSV, { filename: 'people.csv', type: 'text/csv' });
    const c = await t.request('GET', `/${csv.id}`);
    expect(c.headers['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(c.headers['Content-Disposition']).toMatch(/^attachment;/);

    const pdf = await stored(t, PDF, { filename: 'Smlouva č. 1.pdf', type: 'application/pdf' });
    const p = await t.request('GET', `/${pdf.id}`);
    expect(p.headers['Content-Disposition']).toBe(`inline; filename="Smlouva _. 1.pdf"; filename*=UTF-8''Smlouva%20%C4%8D.%201.pdf`);
  });

  it('refuses a non-multipart body (415), a missing file part and an empty file (400), a cross-site upload (403)', async () => {
    const t = ctx();
    const json = await t.request('POST', '/', { body: { file: 'x' } });
    expect(json).toMatchObject({ status: 415, body: { error: 'unsupported_media_type' } });
    const noFile = await t.request('POST', '/', {
      rawBody: `--${BOUNDARY}\r\nContent-Disposition: form-data; name="a"\r\n\r\nb\r\n--${BOUNDARY}--\r\n`,
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    });
    expect(noFile).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    expect(await upload(t, Buffer.alloc(0))).toMatchObject({ status: 400, body: { error: 'invalid_request', message: 'The file is empty.' } });
    const f = form(png(10));
    const csrf = await t.request('POST', '/', { rawBody: f.rawBody, headers: { ...f.headers, 'x-drobek-sdk': '' } });
    expect(csrf).toMatchObject({ status: 403, body: { error: 'csrf_rejected' } });
    expect(onDisk()).toEqual({ blobs: [], tmp: [] });
  });

  it('FILES_UPLOAD_RATE_LIMIT per app → 429 with Retry-After', async () => {
    const t = ctx({ limits: { FILES_UPLOAD_RATE_LIMIT: 2 } });
    await stored(t, png(10));
    await stored(t, png(10));
    const third = await upload(t, png(10));
    expect(third.status).toBe(429);
    expect(third.body).toMatchObject({ error: 'rate_limited', details: { limit: 'FILES_UPLOAD_RATE_LIMIT', value: 2 } });
    expect(Number(third.headers['Retry-After'])).toBeGreaterThan(0);
  });
});

describe('rules', () => {
  it('acceptance: read: user → a visitor gets 401 (uniform shape); a signed-in user 200', async () => {
    const f = await stored(ctx(), png(100));
    const anon = await ctx({ principal: ANON }).request('GET', `/${f.id}`);
    expect(anon.status).toBe(401);
    expect(anon.body).toMatchObject({ error: 'unauthorized', message: expect.stringContaining('Sign in'), hint: "skill_info('files')" });
    // 401 before the lookup: an unknown id answers the same.
    expect((await ctx({ principal: ANON }).request('GET', '/doesnotexist0000')).status).toBe(401);
    expect((await ctx({ principal: BOB }).request('GET', `/${f.id}`)).status).toBe(200);
  });

  it('read: public — anyone downloads it, cached immutably', async () => {
    const f = await stored(ctx({ config: { rules: { read: 'public' } } }), png(100));
    const r = await ctx({ principal: ANON, config: { rules: { read: 'public' } } }).request('GET', `/${f.id}`);
    expect(r.status).toBe(200);
    expect(r.headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
  });

  it('read: owner|admin — another user 403, the uploader and an admin 200', async () => {
    const config = { rules: { read: 'owner|admin' } };
    const f = await stored(ctx({ config }), png(100));
    expect((await ctx({ config, principal: BOB }).request('GET', `/${f.id}`)).status).toBe(403);
    expect((await ctx({ config, principal: ANA }).request('GET', `/${f.id}`)).status).toBe(200);
    expect((await ctx({ config, principal: ADMIN }).request('GET', `/${f.id}`)).status).toBe(200);
  });

  it('upload rules: a visitor 401 by default; upload: admin → a user 403; upload: public → owner null', async () => {
    expect((await upload(ctx({ principal: ANON }), png(10))).status).toBe(401);
    expect((await upload(ctx({ principal: BOB, config: { rules: { upload: 'admin' } } }), png(10))).status).toBe(403);
    expect((await upload(ctx({ principal: ADMIN, config: { rules: { upload: 'admin' } } }), png(10))).status).toBe(201);
    const anon = await stored(ctx({ principal: ANON, config: { rules: { upload: 'public' } } }), png(10));
    expect(anon.owner).toBeNull();
    expect(onDisk().tmp).toEqual([]);
  });

  it("another app never sees this app's files (same id → 404)", async () => {
    const f = await stored(ctx(), png(100));
    expect((await ctx({ app: appB }).request('GET', `/${f.id}`)).status).toBe(404);
    expect((await ctx({ app: appB, principal: ADMIN }).request('DELETE', `/${f.id}`)).status).toBe(404);
    expect((await ctx({ principal: ADMIN }).request('GET', `/${f.id}`)).status).toBe(200);
  });

  it('the list is admin-only, newest first, paged', async () => {
    const t = ctx();
    for (let i = 0; i < 3; i++) {
      await stored(t, png(100 + i));
      await new Promise((r) => setTimeout(r, 5)); // distinct created_at (ms)
    }
    expect((await ctx({ principal: BOB }).request('GET', '/')).status).toBe(403);
    expect((await ctx({ principal: ANON }).request('GET', '/')).status).toBe(401);
    const admin = ctx({ principal: ADMIN });
    const p1 = await admin.request('GET', '/', { query: { limit: '2' } });
    expect(p1.status).toBe(200);
    const b1 = p1.body as { files: Stored[]; next_cursor: string | null; used_bytes: number; quota_bytes: number };
    expect(b1.files.map((f) => f.size)).toEqual([102, 101]);
    expect(b1).toMatchObject({ used_bytes: 303, quota_bytes: 500 * MiB });
    const p2 = (await admin.request('GET', '/', { query: { limit: '2', cursor: b1.next_cursor! } })).body as { files: Stored[]; next_cursor: string | null };
    expect(p2.files.map((f) => f.size)).toEqual([100]);
    expect(p2.next_cursor).toBeNull();
    expect((await admin.request('GET', '/', { query: { cursor: 'bogus' } })).status).toBe(400);
  });
});

describe('delete + dedup', () => {
  it("the uploader or an admin deletes; another user 403; a visitor 401", async () => {
    const f = await stored(ctx(), png(100));
    expect((await ctx({ principal: ANON }).request('DELETE', `/${f.id}`)).status).toBe(401);
    expect((await ctx({ principal: BOB }).request('DELETE', `/${f.id}`)).status).toBe(403);
    const t = ctx({ principal: ANA });
    const del = await t.request('DELETE', `/${f.id}`);
    expect(del).toMatchObject({ status: 200, body: { id: f.id, deleted: true } });
    expect(t.audits.at(-1)).toMatchObject({ action: 'files.delete', meta: { id: f.id } });
    expect((await t.request('GET', `/${f.id}`)).status).toBe(404);
    expect(onDisk().blobs).toEqual([]);

    const g = await stored(ctx({ principal: BOB }), png(100));
    expect((await ctx({ principal: ADMIN }).request('DELETE', `/${g.id}`)).status).toBe(200);
  });

  it('acceptance: the same bytes in two apps are stored once; deleting removes the blob only when no app references it', async () => {
    const bytes = png(2000);
    const h = sha(bytes);
    const a = await stored(ctx({ app: appA }), bytes);
    const b = await stored(ctx({ app: appB }), bytes);
    const a2 = await stored(ctx({ app: appA, principal: BOB }), bytes);
    expect(onDisk().blobs).toEqual([join(h.slice(0, 2), h.slice(2, 4), h)]);

    expect((await ctx({ app: appA }).request('DELETE', `/${a.id}`)).status).toBe(200);
    expect(await blobStore().has(h)).toBe(true); // a2 (same app) and b (app B) still use it
    expect((await ctx({ app: appA, principal: BOB }).request('DELETE', `/${a2.id}`)).status).toBe(200);
    expect(await blobStore().has(h)).toBe(true); // app B still uses it
    const stillB = await ctx({ app: appB }).request('GET', `/${b.id}`);
    expect(stillB.status).toBe(200);
    expect(stillB.bytes.equals(bytes)).toBe(true);
    expect((await ctx({ app: appB }).request('DELETE', `/${b.id}`)).status).toBe(200);
    expect(await blobStore().has(h)).toBe(false);
    expect(onDisk()).toEqual({ blobs: [], tmp: [] });
  });
});

describe('quota', () => {
  it('acceptance: an app at its 500 MiB quota (the default) → 409 quota_exceeded, nothing stored', async () => {
    // Seed 500 MiB − 50 B of stored files (rows only — the quota sums mod_files.size).
    await db.insert(files).values({ id: 'seededbig000001', appId: appA, sha256: 'a'.repeat(64), size: 500 * MiB - 50, type: 'image/png', name: 'big.png', ownerId: null });
    const r = await upload(ctx(), png(100));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'quota_exceeded', details: { limit: 'FILES_QUOTA_PER_APP', value: 500 * MiB }, hint: "skill_info('files')" });
    expect(onDisk()).toEqual({ blobs: [], tmp: [] });
    // Another app has its own quota.
    expect((await upload(ctx({ app: appB }), png(100))).status).toBe(201);
    // Full to the byte → refused before the body is read.
    await db.insert(files).values({ id: 'seededbig000002', appId: appA, sha256: 'b'.repeat(64), size: 50, type: 'image/png', name: '', ownerId: null });
    const full = await upload(ctx(), png(10));
    expect(full.status).toBe(409);
    expect(full.bodyBytesRead).toBe(0);
  });

  it('a lowered FILES_QUOTA_PER_APP: the upload that would cross it is refused', async () => {
    const limits = { FILES_QUOTA_PER_APP: 1000 };
    await stored(ctx({ limits }), png(600));
    const second = await upload(ctx({ limits }), png(600));
    expect(second).toMatchObject({ status: 409, body: { error: 'quota_exceeded', details: { value: 1000, used: 600 } } });
    expect(onDisk().tmp).toEqual([]);
    expect(onDisk().blobs).toHaveLength(1);
    await stored(ctx({ limits }), png(400));
  });
});

describe("the owner's view (files authority, M2-03)", () => {
  const view = (app = appA, limits: Record<string, number> = {}) => ({
    app: { id: app, slug: app === appA ? 'album' : 'other', workspaceId },
    config: filesConfigSchema.parse({}),
    db,
    log: { debug() {}, info() {}, warn() {}, error() {} } as never,
    limits: async () => limits,
  });

  it('lists newest first with usage + quota, opens the bytes (whatever the read rule), stays in its app', async () => {
    const first = await stored(ctx(), png(300), { filename: 'one.png' });
    const second = await stored(ctx({ principal: BOB }), PDF, { filename: 'doc.pdf' });
    const page = await filesAuthority.list(view(appA, { FILES_QUOTA_PER_APP: 5000 }), {});
    expect(page).toMatchObject({ used_bytes: 300 + PDF.length, quota_bytes: 5000, next_cursor: null });
    expect(page.files.map((f) => [f.id, f.type, f.owner])).toEqual([
      [second.id, 'application/pdf', 'eu_bob'],
      [first.id, 'image/png', 'eu_ana'],
    ]);
    const p1 = await filesAuthority.list(view(), { limit: 1 });
    expect((await filesAuthority.list(view(), { limit: 1, cursor: p1.next_cursor })).files.map((f) => f.id)).toEqual([first.id]);

    const opened = await filesAuthority.open(view(), first.id);
    expect(opened?.file).toMatchObject({ id: first.id, name: 'one.png', type: 'image/png', size: 300 });
    const chunks: Buffer[] = [];
    for await (const c of opened!.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).length).toBe(300);
    expect(await filesAuthority.open(view(appB), first.id)).toBeNull();
    expect(await filesAuthority.remove(view(appB), first.id)).toBe(false);
  });

  it('remove keeps content another app still references (the module dedup rule)', async () => {
    const bytes = png(1200);
    const h = sha(bytes);
    const a = await stored(ctx({ app: appA }), bytes);
    const b = await stored(ctx({ app: appB }), bytes);
    expect(await filesAuthority.remove(view(appA), a.id)).toBe(true);
    expect(await blobStore().has(h)).toBe(true);
    expect(await filesAuthority.remove(view(appA), a.id)).toBe(false);
    expect(await filesAuthority.remove(view(appB), b.id)).toBe(true);
    expect(await blobStore().has(h)).toBe(false);
  });
});
