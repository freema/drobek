/**
 * The production loaders (Postgres, via PGlite) behind ServeStore + the
 * app-changed bust: what each host of an app serves as versions are written,
 * published and rolled back, and that the in-process event busts the cache so
 * the FIRST request after a publish already sees the new version.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, createVersion, notifyAppChanged, publish, type Actor } from '@drobek/apps';
import { apps, users, workspaces } from '@drobek/db';
import { addDomain, removeDomain, setPrimaryDomain, verifyDomain, type DnsResolver } from '@drobek/domains';
import { handleAppRequest, type AppRequest, type HandlerDeps } from './handler.js';
import { ServeStore, dbLoaders } from './store.server.js';
import { subscribeServeCache } from './subscriber.server.js';
import { appSlugIsLive } from './tls-ask.server.js';
import { freshDb, type TestDb } from './test/db.js';

let db: TestDb;
let close: () => Promise<void>;
let wsId: string;
let actor: Actor;

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const [u] = await db.insert(users).values({ email: 'owner@example.test' }).returning();
  const [w] = await db.insert(workspaces).values({ kind: 'personal', slug: 'owner', name: 'Owner' }).returning();
  wsId = w.id;
  actor = { userId: u.id, kind: 'agent' };
});
afterAll(async () => close());

const files = (label: string) => [
  { path: 'index.html', content: `<h1>${label}</h1><script type="module" src="/main.js"></script>` },
  { path: 'src/main.tsx', content: `console.log(${JSON.stringify(label)})` },
  { path: 'main.js', content: `console.log(${JSON.stringify(label)})`, kind: 'built' as const },
];

async function write(appId: string, label: string, ok = true) {
  return createVersion(appId, ok ? files(label) : files(label).filter((f) => f.path !== 'main.js'), {
    actor,
    compile: { status: ok ? 'ok' : 'error' },
  });
}

describe('dbLoaders.resolve', () => {
  it('prod = published pointer, preview = newest ok, --vN = N only when ok', async () => {
    const app = await createApp({ workspaceId: wsId, slug: 'loader-app', actor });
    expect(await dbLoaders.resolve({ kind: 'preview', slug: 'loader-app' })).toMatchObject({ version: null });

    const v1 = await write(app.id, 'one');
    const v2 = await write(app.id, 'two');
    await write(app.id, 'three', false);

    expect((await dbLoaders.resolve({ kind: 'prod', slug: 'loader-app' })).version).toBeNull();
    expect((await dbLoaders.resolve({ kind: 'preview', slug: 'loader-app' })).version).toEqual(v2);
    expect((await dbLoaders.resolve({ kind: 'version', slug: 'loader-app', number: 1 })).version).toEqual(v1);
    expect((await dbLoaders.resolve({ kind: 'version', slug: 'loader-app', number: 3 })).version).toBeNull();
    expect((await dbLoaders.resolve({ kind: 'version', slug: 'loader-app', number: 4 })).version).toBeNull();

    await publish(app.id, v1.id, actor);
    const prod = await dbLoaders.resolve({ kind: 'prod', slug: 'loader-app' });
    expect(prod.version).toEqual(v1);
    expect(prod.app).toEqual({ id: app.id, slug: 'loader-app', workspaceId: wsId, visibility: 'public', frameAncestors: null, primaryDomain: null });
  });

  it('a soft-deleted or hibernated app does not exist for the app hosts', async () => {
    const app = await createApp({ workspaceId: wsId, slug: 'gone-app', actor });
    await write(app.id, 'x');
    await db.update(apps).set({ deletedAt: new Date() }).where(eq(apps.id, app.id));
    expect(await dbLoaders.resolve({ kind: 'preview', slug: 'gone-app' })).toEqual({ app: null, version: null });
  });

  it('appSlugIsLive (the TLS ask lookup): live → true; deleted, hibernated, unknown → false', async () => {
    const live = await createApp({ workspaceId: wsId, slug: 'ask-live', actor });
    const gone = await createApp({ workspaceId: wsId, slug: 'ask-gone', actor });
    const asleep = await createApp({ workspaceId: wsId, slug: 'ask-asleep', actor });
    await db.update(apps).set({ deletedAt: new Date() }).where(eq(apps.id, gone.id));
    await db.update(apps).set({ status: 'hibernated' }).where(eq(apps.id, asleep.id));
    expect(await appSlugIsLive(live.slug)).toBe(true);
    expect(await appSlugIsLive('ask-gone')).toBe(false);
    expect(await appSlugIsLive('ask-asleep')).toBe(false);
    expect(await appSlugIsLive('ask-never')).toBe(false);
  });

  it('loads files of both kinds, blobs by hash and the password hash', async () => {
    const app = await createApp({ workspaceId: wsId, slug: 'files-app', actor });
    const v = await write(app.id, 'f');
    const rows = await dbLoaders.loadFiles(v.id);
    expect(rows.map((r) => `${r.kind}:${r.path}`).sort()).toEqual(['built:main.js', 'source:index.html', 'source:src/main.tsx']);
    // main.js and src/main.tsx have identical bytes here → one deduplicated blob.
    const blobs = await dbLoaders.loadBlobs(rows.map((r) => r.sha256));
    expect(blobs.size).toBe(new Set(rows.map((r) => r.sha256)).size);
    for (const r of rows) expect(blobs.get(r.sha256)?.length).toBe(r.size);
    await db.update(apps).set({ visibility: 'password', passwordHash: 'scrypt$aa$bb' }).where(eq(apps.id, app.id));
    expect(await dbLoaders.loadPasswordHash(app.id)).toBe('scrypt$aa$bb');
    expect((await dbLoaders.resolve({ kind: 'prod', slug: 'files-app' })).app?.visibility).toBe('password');
  });
});

describe('cache bust on app-changed', () => {
  function get(target: AppRequest['target'], path = '/'): AppRequest {
    return {
      method: 'GET',
      target,
      path,
      query: '',
      header: () => null,
      readForm: async () => null,
      readBody: async () => null,
      clientIp: null,
    };
  }

  it('the first request after publish / a new version serves the new content', async () => {
    const store = new ServeStore();
    const sub = subscribeServeCache(store, { redis: null });
    const deps: HandlerDeps = { store, accessSecret: null, allowUnlockAttempt: async () => true };
    try {
      const app = await createApp({ workspaceId: wsId, slug: 'bust-app', actor });
      const v1 = await write(app.id, 'first');
      await publish(app.id, v1.id, actor);
      const prod = { kind: 'prod' as const, slug: 'bust-app' };
      const preview = { kind: 'preview' as const, slug: 'bust-app' };
      expect(String((await handleAppRequest(get(prod), deps)).body)).toContain('<h1>first</h1>');
      expect(String((await handleAppRequest(get(preview), deps)).body)).toContain('<h1>first</h1>');

      // A new version: preview follows (after the event), prod does not move.
      const v2 = await write(app.id, 'second');
      await notifyAppChanged({ app_id: app.id, slug: 'bust-app', version: v2.number });
      expect(String((await handleAppRequest(get(preview), deps)).body)).toContain('<h1>second</h1>');
      expect(String((await handleAppRequest(get(prod), deps)).body)).toContain('<h1>first</h1>');

      // Publish v2: the very next prod request serves it.
      await publish(app.id, v2.id, actor);
      await notifyAppChanged({ app_id: app.id, slug: 'bust-app', version: 2, kind: 'publish' });
      expect(String((await handleAppRequest(get(prod), deps)).body)).toContain('<h1>second</h1>');
    } finally {
      await sub.stop();
    }
  });

  it('without an event the cache keeps what it knew (proves the bust is what refreshes it)', async () => {
    const store = new ServeStore();
    const deps: HandlerDeps = { store, accessSecret: null, allowUnlockAttempt: async () => true };
    const app = await createApp({ workspaceId: wsId, slug: 'stale-app', actor });
    await write(app.id, 'old');
    const preview = { kind: 'preview' as const, slug: 'stale-app' };
    expect(String((await handleAppRequest(get(preview), deps)).body)).toContain('<h1>old</h1>');
    await write(app.id, 'new');
    expect(String((await handleAppRequest(get(preview), deps)).body)).toContain('<h1>old</h1>');
    store.bust('stale-app');
    expect(String((await handleAppRequest(get(preview), deps)).body)).toContain('<h1>new</h1>');
  });
});

describe('custom domains through the real loaders (M3-01)', () => {
  const nodata = () => Promise.reject(Object.assign(new Error('nodata'), { code: 'ENODATA' }));

  it('registered → 404 side, verified → the app, primary → prod redirect target, removed → dashboard; domain events bust', async () => {
    const store = new ServeStore();
    const sub = subscribeServeCache(store, { redis: null });
    try {
      const created = await createApp({ workspaceId: wsId, slug: 'domain-app', actor });
      const app = { id: created.id, slug: created.slug, workspaceId: wsId };
      const user = { userId: actor.userId, kind: 'user' as const };
      expect(await store.resolveCustomHost('shop.firma.cz')).toBeNull();

      const d = await addDomain(app, 'shop.firma.cz', user);
      expect(await store.resolveCustomHost('shop.firma.cz')).toEqual({ slug: null });

      const resolver: DnsResolver = {
        resolveTxt: async (n) => (n === '_drobek.shop.firma.cz' ? [[d.instructions.txt.value]] : nodata()),
        resolveCname: async (n) => (n === 'shop.firma.cz' ? [d.instructions.cname.value] : nodata()),
        resolve4: nodata,
        resolve6: nodata,
      };
      await verifyDomain(app, d.id, user, { resolver });
      expect(await store.resolveCustomHost('shop.firma.cz')).toEqual({ slug: 'domain-app' });
      expect((await store.resolve({ kind: 'prod', slug: 'domain-app' })).app?.primaryDomain).toBeNull();

      await setPrimaryDomain(app, d.id, user);
      expect((await store.resolve({ kind: 'prod', slug: 'domain-app' })).app?.primaryDomain).toBe('shop.firma.cz');
      expect((await store.resolve({ kind: 'custom', slug: 'domain-app', hostname: 'shop.firma.cz' })).app?.primaryDomain).toBe('shop.firma.cz');

      await removeDomain(app, d.id, user);
      expect(await store.resolveCustomHost('shop.firma.cz')).toBeNull();
      expect((await store.resolve({ kind: 'prod', slug: 'domain-app' })).app?.primaryDomain).toBeNull();
    } finally {
      await sub.stop();
    }
  });
});
