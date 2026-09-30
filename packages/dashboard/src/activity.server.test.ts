/**
 * The workspace Activity page + its CSV export on a real PGlite database
 * (the workspace role gate is stubbed — requireWorkspaceRole has its
 * own tests — and the module runtime is a list of names):
 *  - rows carry a summary, links to what still exists and plain text with a
 *    note for what was deleted, and redacted technical details;
 *  - the time range narrows the page AND the export the same way; the export
 *    carries the summary column and no redacted value;
 *  - stored rows are not rewritten.
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as schema from '@drobek/db/schema';
import { appVersions, apps, auditLog, memberships, setDbForTests, upstreams, users, workspaces } from '@drobek/db';

const who = vi.hoisted(() => ({
  user: { id: '', email: 'admin@example.com' },
  ws: { id: '', slug: 'smoke', name: 'Smoke', kind: 'team' },
  role: 'workspace-admin' as 'workspace-admin' | 'editor',
}));

vi.mock('@drobek/tenancy', () => ({
  requireWorkspaceRole: async (_request: Request, slug: string, min: string) => {
    if (slug !== who.ws.slug) throw new Response('Not found', { status: 404 });
    if (min === 'workspace-admin' && who.role !== 'workspace-admin') throw new Response('Forbidden', { status: 403 });
    return { user: who.user, workspace: who.ws, membershipRole: who.role, superAdmin: false, effectiveRole: who.role };
  },
  workspaceNav: () => ({ slug: who.ws.slug }),
}));

vi.mock('@drobek/modules', () => ({
  moduleRuntime: async () => ({ moduleFactsList: () => [{ name: 'data' }] }),
}));

const page = await import('./routes/workspaces.$slug.activity.server.js');
const csv = await import('./routes/workspaces.$slug.activity.export-csv.server.js');

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

type Item = {
  action: string;
  summary: string;
  links: { label: string; href: string | null; note: string | null }[];
  details: string | null;
  subject: string | null;
};

async function load(qs = '') {
  const out = (await page.loader({
    request: new Request(`https://drobek.example/workspaces/smoke/activity${qs}`),
    params: { slug: 'smoke' },
    context: {},
  } as never)) as { items: Item[]; filter: Record<string, string | null> };
  return out;
}

async function exportCsv(qs = '') {
  const res = await csv.loader({
    request: new Request(`https://drobek.example/workspaces/smoke/activity/export.csv${qs}`),
    params: { slug: 'smoke' },
    context: {},
  } as never);
  return (await res.text()).split('\r\n').filter((l) => l.length > 0);
}

const at = (iso: string) => new Date(iso);

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg, { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../db/drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_core',
    migrationsSchema: 'drizzle',
  });
  setDbForTests(db);
  const [u] = await db.insert(users).values({ email: 'admin@example.com' }).returning();
  who.user = { id: u.id, email: u.email };
  const [w] = await db.insert(workspaces).values({ kind: 'team', slug: 'smoke', name: 'Smoke' }).returning();
  who.ws = { id: w.id, slug: 'smoke', name: 'Smoke', kind: 'team' };
  await db.insert(memberships).values({ userId: u.id, workspaceId: w.id, role: 'workspace-admin' });
  const [a] = await db.insert(apps).values({ workspaceId: w.id, slug: 'pokedex', name: 'Pokédex', createdAt: at('2026-09-01T00:00:00Z') }).returning();
  await db.insert(appVersions).values({ appId: a.id, number: 3, actorKind: 'agent', compileStatus: 'ok' });
  await db.insert(apps).values({ workspaceId: w.id, slug: 'old-app', deletedAt: at('2026-09-05T00:00:00Z'), createdAt: at('2026-09-01T00:00:00Z') });
  const [up] = await db
    .insert(upstreams)
    .values({ workspaceId: w.id, name: 'github', baseUrl: 'https://api.github.com', allowedMethods: ['GET'], allowedPathPrefixes: ['/'] })
    .returning();
  const row = (action: string, subjectType: string, target: string, meta: Record<string, unknown>, createdAt: string) => ({
    workspaceId: w.id,
    actorUserId: u.id,
    actorKind: 'user' as const,
    action,
    subjectType,
    target,
    meta,
    createdAt: at(createdAt),
  });
  await db.insert(auditLog).values([
    row('app.publish', 'app', 'pokedex', { version: 3, previousVersion: 2 }, '2026-09-10T10:00:00Z'),
    row('app.publish', 'app', 'old-app', { version: 1 }, '2026-09-02T10:00:00Z'),
    row('proxy.upstream.create', 'upstream', up.id, { name: 'github', authType: 'bearer' }, '2026-09-11T10:00:00Z'),
    row('proxy.upstream.delete', 'upstream', 'up_gone', { name: 'legacy' }, '2026-09-12T10:00:00Z'),
    row('module.secret_set', 'app', 'pokedex', { module: 'data', name: 'API_TOKEN', rotated: false, token: 'should-never-show' }, '2026-09-13T10:00:00Z'),
  ]);
});

afterAll(async () => {
  await pg.close();
});

describe('Activity page', () => {
  it('summarises each row and links what still exists', async () => {
    const { items } = await load();
    const by = (action: string, subject?: string) => items.find((i) => i.action === action && (!subject || i.subject === subject))!;
    expect(by('app.publish', 'pokedex')).toMatchObject({
      summary: 'Published version 3 (replacing version 2)',
      links: [
        { label: 'Pokédex (pokedex)', href: '/workspaces/smoke/apps/pokedex', note: null },
        { label: 'version 3', href: '/workspaces/smoke/apps/pokedex/files?version=3', note: null },
      ],
    });
    expect(by('app.publish', 'old-app').links).toEqual([{ label: 'old-app', href: null, note: 'app deleted' }]);
    expect(by('proxy.upstream.create').links[0].href).toMatch(/^\/workspaces\/smoke\/upstreams#upstream-/);
    expect(by('proxy.upstream.delete').links).toEqual([{ label: 'upstream legacy', href: null, note: 'deleted' }]);
    const secret = by('module.secret_set');
    expect(secret.summary).toBe('Set the data module secret API_TOKEN');
    expect(secret.details).toContain('[redacted]');
    expect(JSON.stringify(items)).not.toContain('should-never-show');
  });

  it('the time range narrows the page and the CSV export the same way', async () => {
    const qs = '?from=2026-09-10&to=2026-09-11';
    const { items, filter } = await load(qs);
    expect(filter).toMatchObject({ from: '2026-09-10', to: '2026-09-11' });
    expect(items.map((i) => i.action).sort()).toEqual(['app.publish', 'proxy.upstream.create']);

    const lines = await exportCsv(qs);
    expect(lines[0]).toBe('time,action,actor_kind,actor,subject_type,subject,summary');
    expect(lines.slice(1).map((l) => l.split(',')[1]).sort()).toEqual(['app.publish', 'proxy.upstream.create']);
    expect(lines.join('\n')).toContain('Registered the proxy upstream github');

    const all = await exportCsv();
    expect(all).toHaveLength(6);
    expect(all.join('\n')).not.toContain('should-never-show');
  });

  it('never rewrites stored rows', async () => {
    const before = await db.select().from(auditLog);
    await load();
    await exportCsv();
    expect(await db.select().from(auditLog)).toEqual(before);
    const [still] = await db.select().from(auditLog).where(eq(auditLog.action, 'module.secret_set'));
    expect(still.meta).toMatchObject({ token: 'should-never-show' });
  });

  it('an editor gets 403 for the page and the export', async () => {
    who.role = 'editor';
    await expect(load()).rejects.toMatchObject({ status: 403 });
    await expect(exportCsv()).rejects.toMatchObject({ status: 403 });
    who.role = 'workspace-admin';
  });
});
