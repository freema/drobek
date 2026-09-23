/**
 * NSO-293 over a real MCP client on a real (PGlite) database: a super-admin
 * takedown makes write_files / restore_version / publish / configure_module
 * refuse with `app_locked_by_admin` (distinct from the lease's `app_locked`),
 * list_apps / get_app show `locked_by_admin`, a restore lifts it; and the
 * publish heuristic flags a compiled "bank login" app but not a calculator.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { restoreApp, takedownApp } from '@drobek/apps';
import { abuseReports, apps, memberships, users, workspaces } from '@drobek/db';
import type { ToolPrincipal } from './context.js';
import { freshDb, type TestDb } from './test/db.js';
import { connect, testDeps, type TestDeps } from './test/harness.js';

let db: TestDb;
let close: () => Promise<void>;
let alice: ToolPrincipal;
let rootId: string;
let deps: TestDeps;

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const [a] = await db.insert(users).values({ email: 'alice@example.test' }).returning();
  const [r] = await db.insert(users).values({ email: 'root@example.test' }).returning();
  rootId = r.id;
  const [ws] = await db.insert(workspaces).values({ kind: 'team', slug: 'team-a', name: 'Team A' }).returning();
  await db.insert(memberships).values({ userId: a.id, workspaceId: ws.id, role: 'workspace-admin' });
  alice = { userId: a.id, email: 'alice@example.test', superAdmin: false };
});
afterAll(async () => close());
beforeEach(() => {
  deps = testDeps();
});

const BANK_TSX = [
  "import { createRoot } from 'react-dom/client';",
  "import './styles.css';",
  '',
  'function App() {',
  '  return (',
  '    <form>',
  '      <h1>Bank login</h1>',
  '      <input name="client" placeholder="Client number" />',
  '      <input name="pin" type="password" />',
  '      <button>Sign in</button>',
  '    </form>',
  '  );',
  '}',
  '',
  "createRoot(document.getElementById('root')!).render(<App />);",
  '',
].join('\n');

async function newApp(c: Awaited<ReturnType<typeof connect>>, name: string) {
  const r = await c.call('create_app', { name, workspace: 'team-a' });
  expect(r.isError, r.text).toBe(false);
  return r.body as { app_id: string; slug: string };
}

describe('publish heuristic through the MCP publish tool', () => {
  it('flags the compiled "bank login" app (published anyway) and not the calculator', async () => {
    const c = await connect(alice, deps);
    try {
      const bank = await newApp(c, 'Bank Login');
      const w = await c.call('write_files', {
        app_id: bank.app_id,
        files: [{ path: 'src/main.tsx', content: BANK_TSX }],
        reasoning: 'login form',
      });
      expect(w.isError, w.text).toBe(false);
      expect((w.body as { compile: { ok: boolean } }).compile.ok).toBe(true);
      const p = await c.call('publish', { app_id: bank.app_id });
      expect(p.isError, p.text).toBe(false);
      expect(p.body).toMatchObject({ published_version: 2 });
      const flagged = await db.select().from(abuseReports).where(eq(abuseReports.appId, bank.app_id));
      expect(flagged).toHaveLength(1);
      expect(flagged[0]).toMatchObject({ reason: 'heuristic', status: 'open' });
      // The production host of the app (APPS_DOMAIN of the process env).
      expect(flagged[0].host.startsWith(`${bank.slug}.`)).toBe(true);
      expect(flagged[0].details).toMatch(/password field .*main\.js.*"bank"/);
      // The agent learns nothing about the flag.
      expect(JSON.stringify(p.body)).not.toMatch(/heuristic|flag|abuse/i);

      const calc = await newApp(c, 'Calculator');
      expect((await c.call('publish', { app_id: calc.app_id })).isError).toBe(false);
      expect(await db.select().from(abuseReports).where(eq(abuseReports.appId, calc.app_id))).toHaveLength(0);
    } finally {
      await c.close();
    }
  });
});

describe('a taken-down app (app_locked_by_admin)', () => {
  it('refuses write_files, restore_version, publish, configure_module; shows locked_by_admin; restore lifts it', async () => {
    const c = await connect(alice, deps);
    try {
      const app = await newApp(c, 'Evil Twin');
      expect((await c.call('publish', { app_id: app.app_id })).isError).toBe(false);
      await takedownApp({ appId: app.app_id, reason: 'phishing', actorUserId: rootId });
      const [row] = await db.select().from(apps).where(eq(apps.id, app.app_id));
      expect(row.publishedVersionId).toBeNull();

      const attempts: [string, Record<string, unknown>][] = [
        ['write_files', { app_id: app.app_id, files: [{ path: 'src/a.ts', content: 'export {}' }], reasoning: 'x' }],
        ['restore_version', { app_id: app.app_id, version: 1 }],
        ['publish', { app_id: app.app_id }],
        ['configure_module', { app_id: app.app_id, module: 'greet', config: { emoji: true } }],
      ];
      for (const [tool, args] of attempts) {
        const r = await c.call(tool, args);
        expect(r.isError, tool).toBe(true);
        const body = JSON.parse(r.text) as Record<string, unknown>;
        expect(body, tool).toMatchObject({ code: 'app_locked_by_admin', reason: 'phishing' });
        expect(String(body.message)).toMatch(/taken down by the server operator \(reason: phishing/);
        expect(String(body.hint)).toMatch(/only the operator can restore it/i);
      }

      const got = await c.call('get_app', { app_id: app.app_id });
      expect(got.isError, got.text).toBe(false);
      expect(got.body).toMatchObject({ locked_by_admin: true, locked_reason: 'phishing' });
      expect(got.body.published_url).toBeUndefined();
      const list = await c.call('list_apps');
      const listed = (list.body.apps as { app_id: string; locked_by_admin?: boolean }[]).find((a) => a.app_id === app.app_id);
      expect(listed?.locked_by_admin).toBe(true);
      // Reads still work.
      expect((await c.call('read_file', { app_id: app.app_id, path: 'index.html' })).isError).toBe(false);

      await restoreApp({ appId: app.app_id, actorUserId: rootId });
      const after = await c.call('get_app', { app_id: app.app_id });
      expect(after.body.locked_by_admin).toBeUndefined();
      const w = await c.call('write_files', {
        app_id: app.app_id,
        files: [{ path: 'src/a.ts', content: 'export {}' }],
        reasoning: 'writable again',
      });
      expect(w.isError, w.text).toBe(false);
      expect((await c.call('publish', { app_id: app.app_id })).isError).toBe(false);
      const open = await db
        .select()
        .from(abuseReports)
        .where(and(eq(abuseReports.appId, app.app_id), eq(abuseReports.status, 'open')));
      expect(open).toHaveLength(0);
    } finally {
      await c.close();
    }
  });
});
