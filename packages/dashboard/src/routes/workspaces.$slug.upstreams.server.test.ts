/**
 * The Upstreams page's server half against a real PGlite database (the
 * workspace role gate is stubbed — requireWorkspaceRole has its own tests in
 * @drobek/tenancy): registering takes the "Stream responses" checkbox (off by
 * default), the toggle turns streaming on and off for a registered upstream
 * (audited `proxy.upstream.update` with `allowStreaming`, a repeat writes no
 * row), the loader lists `allowStreaming` and accepts only `streaming=1` as a
 * prefill; an editor is refused.
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as schema from '@drobek/db/schema';
import { auditLog, setDbForTests, upstreams, users, workspaces } from '@drobek/db';

const role = vi.hoisted(() => ({
  current: 'workspace-admin' as 'editor' | 'workspace-admin',
  user: { id: '', email: 'admin@example.com' },
  ws: { id: '', slug: 'acme', name: 'Acme', kind: 'team' },
}));

vi.mock('@drobek/tenancy', async (importOriginal) => {
  const rank = { viewer: 1, editor: 2, 'workspace-admin': 3 } as const;
  return {
    ...(await importOriginal<typeof import('@drobek/tenancy')>()),
    requireWorkspaceRole: async (_request: Request, slug: string, min: keyof typeof rank) => {
      if (slug !== role.ws.slug) throw new Response('Not found', { status: 404 });
      if (rank[role.current] < rank[min]) throw new Response('Forbidden', { status: 403 });
      return { user: role.user, workspace: role.ws, membershipRole: role.current, superAdmin: false, effectiveRole: role.current };
    },
    workspaceNav: async () => ({ slug: role.ws.slug, name: role.ws.name, kind: role.ws.kind, role: role.current }),
  };
});

vi.mock('@drobek/modules', () => ({
  moduleRuntime: async () => ({ workspaceLimits: async () => ({ UPSTREAMS_MAX_PER_WORKSPACE: 20 }) }),
}));

const page = await import('./workspaces.$slug.upstreams.server.js');

let pg: PGlite;
const db = () => drizzle(pg, { schema });
const base = 'https://drobek.example/workspaces/acme/upstreams';
const params = { slug: 'acme' };

const post = (body: Record<string, string>) =>
  page.action({ request: new Request(base, { method: 'POST', body: new URLSearchParams(body) }), params, context: {} } as never);
const load = (query = '') => page.loader({ request: new Request(`${base}${query}`), params, context: {} } as never);
const status = (res: unknown) => (res instanceof Response ? res.status : ((res as { init: { status: number } | null }).init?.status ?? 200));

const register = (name: string, extra: Record<string, string> = {}) =>
  post({ intent: 'create', name, baseUrl: `https://${name}.example.com`, methods: 'POST', pathPrefixes: '/v1', authType: 'none', ...extra });

async function row(name: string) {
  const [r] = await db().select().from(upstreams).where(eq(upstreams.name, name));
  return r;
}

beforeAll(async () => {
  pg = new PGlite();
  await migrate(db(), {
    migrationsFolder: fileURLToPath(new URL('../../../db/drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_core',
    migrationsSchema: 'drizzle',
  });
  setDbForTests(db());
  const [u] = await db().insert(users).values({ email: 'admin@example.com' }).returning();
  role.user = { id: u.id, email: u.email };
  const [w] = await db().insert(workspaces).values({ kind: 'team', slug: 'acme', name: 'Acme' }).returning();
  role.ws = { ...role.ws, id: w.id };
});

afterAll(async () => {
  await pg.close();
});

describe('the Upstreams page: streaming passthrough', () => {
  it('registers buffered by default and streaming with the checkbox; the create audit row names allowStreaming', async () => {
    expect(status(await register('plain'))).toBe(302);
    expect(status(await register('llm', { allowStreaming: '1' }))).toBe(302);
    expect((await row('plain')).allowStreaming).toBe(false);
    const llm = await row('llm');
    expect(llm.allowStreaming).toBe(true);
    const [audit] = await db().select().from(auditLog).where(eq(auditLog.target, llm.id));
    expect(audit.action).toBe('proxy.upstream.create');
    expect(audit.meta).toMatchObject({ name: 'llm', allowStreaming: true });
  });

  it('the toggle turns streaming on and off, audited as proxy.upstream.update; the same value again writes no row', async () => {
    const plain = await row('plain');
    expect(status(await post({ intent: 'streaming', id: plain.id, allowStreaming: '1' }))).toBe(302);
    expect((await row('plain')).allowStreaming).toBe(true);
    expect(status(await post({ intent: 'streaming', id: plain.id, allowStreaming: '1' }))).toBe(302);
    expect(status(await post({ intent: 'streaming', id: plain.id, allowStreaming: '0' }))).toBe(302);
    expect((await row('plain')).allowStreaming).toBe(false);
    const updates = await db().select().from(auditLog).where(eq(auditLog.action, 'proxy.upstream.update'));
    expect(updates.map((a) => [a.target, a.meta])).toEqual([
      [plain.id, { name: 'plain', allowStreaming: true }],
      [plain.id, { name: 'plain', allowStreaming: false }],
    ]);
  });

  it('an unknown upstream id is 404 and changes nothing', async () => {
    expect(status(await post({ intent: 'streaming', id: 'nope', allowStreaming: '1' }))).toBe(404);
  });

  it('the loader lists allowStreaming and the stream cap in minutes; only streaming=1 prefills the checkbox', async () => {
    const data = (await load('?name=llm2&streaming=1')) as Awaited<ReturnType<typeof page.loader>>;
    expect(data.upstreams.map((u) => [u.name, u.allowStreaming])).toEqual([
      ['llm', true],
      ['plain', false],
    ]);
    expect(data.streamMaxMinutes).toBe(5);
    expect(data.prefill).toEqual({ name: 'llm2', streaming: '1' });
    const odd = (await load('?name=x&streaming=yes')) as Awaited<ReturnType<typeof page.loader>>;
    expect(odd.prefill).toEqual({ name: 'x' });
  });

  it('an editor cannot change streaming', async () => {
    const llm = await row('llm');
    role.current = 'editor';
    try {
      const res = await post({ intent: 'streaming', id: llm.id, allowStreaming: '0' }).catch((e: unknown) => e);
      expect(status(res)).toBe(403);
    } finally {
      role.current = 'workspace-admin';
    }
    expect((await row('llm')).allowStreaming).toBe(true);
  });
});
