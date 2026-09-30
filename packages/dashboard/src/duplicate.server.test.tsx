/**
 * /duplicate/:slug on a real PGlite database (the session is
 * stubbed; workspaces and roles are real):
 *  - signed out → /login?returnTo=/duplicate/<slug>;
 *  - the confirm page: the source's public facts, the editor+ workspaces
 *    (personal first, a viewer workspace left out), the default name;
 *  - refusals: not in the gallery (404), duplicates off (403), no gallery (404);
 *  - Duplicate: a new app in the picked workspace with the published files,
 *    provenance and the module settings proposed (public access waits for
 *    confirmation); a workspace the user cannot edit → 403.
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@drobek/db/schema';
import { apps, memberships, moduleConfigs, setDbForTests, users, workspaces } from '@drobek/db';
import { createApp, createVersion, getVersion, publish, readVersionFile, setGalleryListing, type Actor } from '@drobek/apps';
import { noopLogger } from '@drobek/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { DuplicateResult } from './duplicate-result.js';
import { defineModule, loadModuleRuntime, memoryMailGuard, memoryRateLimiter, setModuleRuntimeForTests, z } from '@drobek/modules';

const session = vi.hoisted(() => ({ user: null as { id: string; email: string } | null }));

vi.mock('@drobek/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drobek/auth')>()),
  getSessionUser: async () => session.user,
}));

const route = await import('./routes/duplicate.$slug.server.js');
const { parseDuplicateResult } = await import('./duplicate-result.server.js');

const ENV = {
  GALLERY_ENABLED: 'true',
  APPS_DOMAIN: 'apps.example.test',
  APPS_URL_SCHEME: 'https',
  PUBLIC_APP_URL: 'https://dash.example.test',
};

const notes = defineModule<{ access: 'public' | 'user'; title: string }>({
  name: 'notes',
  version: '1.0.0',
  skill: { useWhen: 'you keep notes in a test', markdown: '# notes\n' },
  configSchema: z.object({ access: z.enum(['public', 'user']), title: z.string() }),
  configDefaults: { access: 'user', title: '' },
  confirmRequired: (before, after) => (before.access !== after.access && after.access === 'public' ? ['access: anyone can read'] : []),
});

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let copier: { id: string; email: string };
let author: Actor;
let n = 0;

function result(res: unknown): { status: number; data: Record<string, unknown> } {
  const d = res as { data: Record<string, unknown>; init: { status?: number } | null };
  return { status: d.init?.status ?? 200, data: d.data };
}

async function thrown(p: Promise<unknown>): Promise<Response> {
  return p.then(
    () => {
      throw new Error('expected a thrown response');
    },
    (e: unknown) => e as Response
  );
}

const load = (slug: string) =>
  route.loader({ request: new Request(`https://dash.example.test/duplicate/${slug}`), params: { slug }, context: {} } as never);
const post = (slug: string, body: Record<string, string>) =>
  route.action({
    request: new Request(`https://dash.example.test/duplicate/${slug}`, { method: 'POST', body: new URLSearchParams(body) }),
    params: { slug },
    context: {},
  } as never);

async function galleryApp(allowDuplicate = true) {
  n += 1;
  const [w] = await db.select().from(workspaces).where(eq(workspaces.slug, 'studio'));
  const app = await createApp({ workspaceId: w.id, slug: `pixel-${n}`, name: `Pixel ${n}`, actor: author });
  const v = await createVersion(app.id, [{ path: 'index.html', content: '<h1>pixels</h1>' }], { actor: author, compile: { status: 'ok' } });
  await publish(app.id, v.id, author, { screen: false });
  await setGalleryListing(app.id, { listed: true, description: 'Paint pixels.', allowDuplicate }, author);
  await db.insert(moduleConfigs).values({ appId: app.id, module: 'notes', config: { access: 'public', title: 'Wall' } });
  return app;
}

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  pg = new PGlite();
  db = drizzle(pg, { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../db/drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_core',
    migrationsSchema: 'drizzle',
  });
  setDbForTests(db);
  const [a] = await db.insert(users).values({ email: 'author@example.test' }).returning();
  const [c] = await db.insert(users).values({ email: 'copier@example.test' }).returning();
  author = { userId: a.id, kind: 'user' };
  copier = { id: c.id, email: c.email };
  await db.insert(workspaces).values({ kind: 'team', slug: 'studio', name: 'Pixel Studio' });
  const [team] = await db.insert(workspaces).values({ kind: 'team', slug: 'crew', name: 'Crew' }).returning();
  const [ro] = await db.insert(workspaces).values({ kind: 'team', slug: 'readonly', name: 'Read only' }).returning();
  await db.insert(memberships).values([
    { userId: c.id, workspaceId: team.id, role: 'editor' },
    { userId: c.id, workspaceId: ro.id, role: 'viewer' },
  ]);
  const rt = await loadModuleRuntime({
    env: ENV,
    log: noopLogger,
    modules: [notes],
    skillsDir: null,
    deps: {
      rateLimit: memoryRateLimiter(),
      principal: async () => ({ kind: 'anon' }),
      email: { send: async () => {} },
      mailGuard: memoryMailGuard({ hourlyMax: 100, pauseMinutes: 1 }, noopLogger),
    },
  });
  setModuleRuntimeForTests(rt);
});

afterAll(async () => {
  setModuleRuntimeForTests(null);
  vi.unstubAllEnvs();
  await pg.close();
});

beforeEach(() => {
  session.user = copier;
  vi.stubEnv('GALLERY_ENABLED', 'true');
});

describe('/duplicate/:slug', () => {
  it('signed out → the login page, which brings the visitor back', async () => {
    session.user = null;
    const res = await thrown(load('pixel-x'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/login?returnTo=${encodeURIComponent('/duplicate/pixel-x')}`);
    expect((await thrown(post('pixel-x', {}))).headers.get('location')).toContain('/login?returnTo=');
  });

  it('shows the source and the editor+ workspaces, personal first', async () => {
    const app = await galleryApp();
    const page = result(await load(app.slug));
    expect(page.status).toBe(200);
    expect(page.data).toMatchObject({
      refused: null,
      source: { slug: app.slug, name: `Pixel ${n}`, description: 'Paint pixels.', workspaceName: 'Pixel Studio', modules: ['notes'] },
      defaultName: `Pixel ${n} copy`,
    });
    const ws = page.data.workspaces as { slug: string; personal: boolean }[];
    expect(ws[0].personal).toBe(true);
    expect(ws.map((w) => w.slug)).toContain('crew');
    expect(ws.map((w) => w.slug)).not.toContain('readonly');
    expect(JSON.stringify(page.data)).not.toContain(app.id);
  });

  it('refuses an app outside the gallery, one without duplicates, and a server without a gallery', async () => {
    expect(result(await load('no-such-app')).data).toMatchObject({ refused: 'not_found' });
    expect(result(await load('no-such-app')).status).toBe(404);
    const closed = await galleryApp(false);
    expect(result(await load(closed.slug))).toMatchObject({ status: 403, data: { refused: 'not_duplicable' } });
    expect(result(await post(closed.slug, { workspace: 'crew' })).status).toBe(403);
    vi.stubEnv('GALLERY_ENABLED', '');
    expect(result(await load(closed.slug))).toMatchObject({ status: 404, data: { refused: 'gallery_disabled' } });
  });

  it('Duplicate creates the copy in the picked workspace and opens it', async () => {
    const app = await galleryApp();
    const res = (await post(app.slug, { workspace: 'crew', name: '  My pixels ' })) as Response;
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toMatch(new RegExp(`^/workspaces/crew/apps/my-pixels[a-z0-9-]*\\?duplicated=${app.slug}&pending=notes$`));
    const slug = location.split('/apps/')[1].split('?')[0];
    const [copy] = await db.select().from(apps).where(eq(apps.slug, slug));
    expect(copy).toMatchObject({ name: 'My pixels', duplicatedFromAppId: app.id, duplicatedFromSlug: app.slug, publishedVersionId: null });
    const v = await getVersion(copy.id, { number: 1 });
    expect((await readVersionFile(v!.id, 'index.html'))?.toString('utf8')).toBe('<h1>pixels</h1>');
    const [cfg] = await db.select().from(moduleConfigs).where(and(eq(moduleConfigs.appId, copy.id), eq(moduleConfigs.module, 'notes')));
    expect((cfg.pending as { changes?: string[] } | null)?.changes).toEqual(['access: anyone can read']);
  });

  it('carries applied, pending and skipped module settings to the copy\'s page', async () => {
    const app = await galleryApp();
    await db.insert(moduleConfigs).values([
      { appId: app.id, module: 'proxy', config: { upstreams: ['api'] } },
      { appId: app.id, module: 'ghost', config: { on: true } },
    ]);
    const res = (await post(app.slug, { workspace: 'crew' })) as Response;
    const location = res.headers.get('location') ?? '';
    const url = new URL(location, 'https://dash.example.test');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      duplicated: app.slug,
      pending: 'notes',
      skipped: 'ghost:not_enabled,proxy:not_copied',
    });
    const modulesPath = `${url.pathname}/modules`;
    const view = parseDuplicateResult(url, modulesPath);
    expect(view).toEqual({
      from: app.slug,
      applied: [],
      pending: [{ module: 'notes', href: `${modulesPath}/notes` }],
      skipped: [
        { module: 'ghost', reason: 'not_enabled', href: `${modulesPath}/ghost` },
        { module: 'proxy', reason: 'not_copied', href: `${modulesPath}/proxy` },
      ],
      modulesHref: modulesPath,
      dismissHref: url.pathname,
    });
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DuplicateResult result={view} />
      </MemoryRouter>
    );
    expect(html).toContain(`Copied from ${app.slug}. Some module settings were not copied.`);
    expect(html).toContain(`href="${modulesPath}/notes"`);
    expect(html).toMatch(/ghost<\/strong>: not copied — this module is not available in this workspace/);
    expect(html).toContain(`href="${modulesPath}"`);
    expect(html).toMatch(/proxy<\/strong>: not copied — its settings point at records of the original/);
    expect(html).toContain(`href="${modulesPath}/proxy"`);
  });

  it('the copy\'s page ignores a hand-made or empty outcome query', () => {
    const at = (q: string) => parseDuplicateResult(new URL(`https://dash.example.test/workspaces/crew/apps/x${q}`), '/m');
    expect(at('')).toBeNull();
    expect(at('?duplicated=<script>')).toBeNull();
    expect(at('?duplicated=wall&applied=forms,Bad!,forms&pending=x&skipped=data:gone,files:invalid,<b>:invalid')).toEqual({
      from: 'wall',
      applied: ['forms'],
      pending: [],
      skipped: [{ module: 'files', reason: 'invalid', href: '/m/files' }],
      modulesHref: '/m',
      dismissHref: '/workspaces/crew/apps/x',
    });
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DuplicateResult result={at('?duplicated=wall')} />
      </MemoryRouter>
    );
    expect(html).toContain('Copied from wall. The original had no module settings to copy.');
  });

  it('refuses a workspace the user cannot create apps in', async () => {
    const app = await galleryApp();
    expect(result(await post(app.slug, { workspace: 'readonly' })).status).toBe(403);
    expect(result(await post(app.slug, { workspace: 'studio' })).status).toBe(403);
  });
});
