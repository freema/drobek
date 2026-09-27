/**
 * NSO-366 in the dashboard, on a real PGlite database (the session and the
 * workspace role gate are stubbed — they have their own tests):
 *  - /admin/publishing: only a super-admin reads it or acts (403 otherwise);
 *    the waiting requests are listed; Approve / Revoke / Block / Unblock
 *    change the workspace and audit `workspace.publish_approve` /
 *    `_revoke` / `_block` / `_unblock`;
 *  - the apps list shows the approval notice while the workspace may not
 *    publish; "Request approval" (editor+) records the request (a viewer →
 *    403) and the notice then says it was sent; an approved workspace shows
 *    no notice; a blocked one shows the operator's notice and never records
 *    a request.
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@drobek/db/schema';
import { auditLog, memberships, setDbForTests, users, workspaces } from '@drobek/db';

const who = vi.hoisted(() => ({
  user: { id: '', email: 'boss@example.com' },
  ws: { id: '', slug: 'acme', name: 'Acme', kind: 'team' },
  effective: 'workspace-admin' as 'workspace-admin' | 'editor' | 'viewer',
}));

vi.mock('@drobek/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drobek/auth')>()),
  requireSessionUser: async () => who.user,
}));

vi.mock('@drobek/tenancy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drobek/tenancy')>()),
  requireWorkspaceRole: async (_request: Request, slug: string) => {
    if (slug !== who.ws.slug) throw new Response('Not found', { status: 404 });
    return { user: who.user, workspace: who.ws, membershipRole: who.effective, superAdmin: false, effectiveRole: who.effective };
  },
  workspaceNav: () => ({ slug: who.ws.slug }),
}));

const admin = await import('./routes/admin.publishing.server.js');
const list = await import('./routes/workspaces.$slug.apps.server.js');

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let bossId: string;
let ownerId: string;

function result(res: unknown): { status: number; data: Record<string, unknown> } {
  const d = res as { data: Record<string, unknown>; init: { status?: number } | null };
  return { status: d.init?.status ?? 200, data: d.data };
}

async function thrownStatus(p: Promise<unknown>): Promise<number> {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  const d = err as { init?: { status?: number }; status?: number } | null;
  return d?.init?.status ?? d?.status ?? 0;
}

const adminLoad = (qs = '') =>
  admin.loader({ request: new Request(`https://drobek.example/admin/publishing${qs}`), params: {}, context: {} } as never);
const adminPost = (body: Record<string, string>) =>
  admin.action({
    request: new Request('https://drobek.example/admin/publishing', { method: 'POST', body: new URLSearchParams(body) }),
    params: {},
    context: {},
  } as never);
const listLoad = () =>
  list.loader({ request: new Request('https://drobek.example/workspaces/acme/apps'), params: { slug: 'acme' }, context: {} } as never);
const listPost = (body: Record<string, string>) =>
  list.action({
    request: new Request('https://drobek.example/workspaces/acme/apps', { method: 'POST', body: new URLSearchParams(body) }),
    params: { slug: 'acme' },
    context: {},
  } as never);

beforeAll(async () => {
  vi.stubEnv('PUBLISH_APPROVAL', 'approval');
  vi.stubEnv('SUPERADMIN_EMAIL', 'boss@example.com');
  vi.stubEnv('OPERATOR_EMAIL', 'ops@example.com');
  pg = new PGlite();
  db = drizzle(pg, { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../db/drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_core',
    migrationsSchema: 'drizzle',
  });
  setDbForTests(db);
  const [b] = await db.insert(users).values({ email: 'boss@example.com' }).returning();
  const [o] = await db.insert(users).values({ email: 'owner@example.com' }).returning();
  bossId = b.id;
  ownerId = o.id;
  const [w] = await db.insert(workspaces).values({ kind: 'team', slug: 'acme', name: 'Acme' }).returning();
  who.ws = { id: w.id, slug: w.slug, name: w.name, kind: 'team' };
  await db.insert(memberships).values({ userId: o.id, workspaceId: w.id, role: 'workspace-admin' });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await pg.close();
});

beforeEach(() => {
  who.user = { id: ownerId, email: 'owner@example.com' };
  who.effective = 'workspace-admin';
});

describe('the workspace apps list', () => {
  it('shows the notice; a viewer cannot request; an editor requests once and the notice says it was sent', async () => {
    const before = (await listLoad()) as { publishApproval: Record<string, unknown> | null; canRequestApproval: boolean };
    expect(before.publishApproval).toMatchObject({
      kind: 'approval',
      contact: 'ops@example.com',
      notice: 'Publishing on this server needs approval from ops@example.com.',
      requestPending: false,
    });
    expect(before.canRequestApproval).toBe(true);

    who.effective = 'viewer';
    expect(result(await listPost({ intent: 'request-publish-approval' })).status).toBe(403);
    expect((await db.select().from(workspaces).where(eq(workspaces.id, who.ws.id)))[0].publishApprovalRequestedAt).toBeNull();

    who.effective = 'editor';
    const res = (await listPost({ intent: 'request-publish-approval', redirectTo: '/workspaces/acme/apps?q=x' })) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/workspaces/acme/apps?q=x');
    const after = (await listLoad()) as { publishApproval: Record<string, unknown> | null };
    expect(after.publishApproval).toMatchObject({ requestPending: true });
    expect(typeof after.publishApproval?.requestedAt).toBe('string');
    expect(result(await listPost({ intent: 'other' })).status).toBe(400);
  });
});

describe('/admin/publishing', () => {
  it('refuses anyone but a super-admin (loader and action)', async () => {
    expect(await thrownStatus(adminLoad())).toBe(403);
    expect(await thrownStatus(adminPost({ intent: 'approve', workspaceId: who.ws.id }))).toBe(403);
  });

  it('lists the waiting request; approve and revoke change the workspace and audit it', async () => {
    who.user = { id: bossId, email: 'boss@example.com' };
    const page = result(await adminLoad());
    expect(page.data).toMatchObject({ state: 'requested', mode: 'approval', contact: 'ops@example.com' });
    const rows = page.data.workspaces as Record<string, unknown>[];
    expect(rows.find((r) => r.slug === 'acme')).toMatchObject({ requestedBy: 'owner@example.com', approvedAt: null, admins: ['owner@example.com'] });

    expect(result(await adminPost({ intent: 'approve', workspaceId: who.ws.id })).data).toMatchObject({ ok: true, message: 'acme may publish now.' });
    expect(((result(await adminLoad('?state=allowed')).data.workspaces as Record<string, unknown>[]).find((r) => r.slug === 'acme'))).toMatchObject({
      approvedBy: 'boss@example.com',
      publishing: 'allowed',
    });
    who.user = { id: ownerId, email: 'owner@example.com' };
    expect(((await listLoad()) as { publishApproval: unknown }).publishApproval).toBeNull();

    who.user = { id: bossId, email: 'boss@example.com' };
    expect(result(await adminPost({ intent: 'revoke', workspaceId: who.ws.id })).data).toMatchObject({ ok: true });
    expect(result(await adminPost({ intent: 'approve', workspaceId: 'nope' })).status).toBe(404);
    expect(result(await adminPost({ intent: 'bogus', workspaceId: who.ws.id })).status).toBe(400);
    expect(result(await adminPost({ intent: 'constructor', workspaceId: who.ws.id })).status).toBe(400);
  });

  it('block shows the operator\'s notice to the owner, records no request; unblock takes it back; ?workspace= shows one', async () => {
    who.user = { id: bossId, email: 'boss@example.com' };
    expect(result(await adminPost({ intent: 'block', workspaceId: who.ws.id })).data).toMatchObject({
      ok: true,
      message: 'acme can no longer publish. Its live apps keep serving; its editors and admins were e-mailed.',
    });
    const one = result(await adminLoad('?workspace=acme'));
    expect(one.data).toMatchObject({ workspace: 'acme', state: 'all' });
    expect(one.data.workspaces).toEqual([expect.objectContaining({ slug: 'acme', publishing: 'blocked', blockedBy: 'boss@example.com', liveApps: [] })]);
    expect((result(await adminLoad('?state=blocked')).data.workspaces as Record<string, unknown>[]).map((r) => r.slug)).toEqual(['acme']);

    who.user = { id: ownerId, email: 'owner@example.com' };
    who.effective = 'editor';
    const page = (await listLoad()) as { publishApproval: Record<string, unknown> | null };
    expect(page.publishApproval).toEqual({
      kind: 'blocked',
      contact: 'ops@example.com',
      notice: 'Publishing from this workspace was turned off by the operator (ops@example.com).',
      requestedAt: null,
      requestPending: false,
    });
    const res = (await listPost({ intent: 'request-publish-approval' })) as Response;
    expect(res.status).toBe(302);
    expect((await db.select().from(workspaces).where(eq(workspaces.id, who.ws.id)))[0].publishApprovalRequestedAt).toBeNull();

    who.user = { id: bossId, email: 'boss@example.com' };
    expect(result(await adminPost({ intent: 'unblock', workspaceId: who.ws.id })).data).toMatchObject({
      ok: true,
      message: 'acme is unblocked; it publishes once approved. Its editors and admins were e-mailed.',
    });
    const actions = (await db.select().from(auditLog).where(eq(auditLog.actorUserId, bossId))).map((r) => r.action);
    expect(actions).toEqual(['workspace.publish_approve', 'workspace.publish_revoke', 'workspace.publish_block', 'workspace.publish_unblock']);
  });
});
