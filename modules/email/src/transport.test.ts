/**
 * A module's transport in the `email.transport` slot this module hosts
 * carries the server's mail: the real module runtime with `email` and a
 * fixture transport module, EMAIL_TRANSPORT naming the fixture. A dashboard
 * sign-in code (@drobek/auth) and an `email` module notification
 * (drobek.email.notifyAdmins through the platform route) both reach it.
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sendLoginCodeEmail } from '@drobek/auth';
import { noopLogger } from '@drobek/core';
import { resetEmailTransportForTests } from '@drobek/email';
import { apps, memberships, setDbForTests, users, workspaces, type DB } from '@drobek/db';
import * as schema from '@drobek/db/schema';
import {
  defineEmailTransport,
  defineModule,
  loadModuleRuntime,
  memoryMailGuard,
  memoryRateLimiter,
  z,
  type EmailTransportMessage,
  type ModuleRuntime,
  type PlatformApp,
  type PlatformRequest,
} from '@drobek/modules';
import email from './index.js';

const CORE_MIGRATIONS = fileURLToPath(new URL('../../../packages/db/drizzle/migrations', import.meta.url));
const TOKEN = 'relay_test_fake_token_0123';
const ENV = {
  APPS_DOMAIN: 'apps.localhost:3041',
  PUBLIC_APP_URL: 'http://localhost:3041',
  DROBEK_MASTER_KEY: 'cd'.repeat(32),
  DROBEK_MIGRATE_ON_START: '0',
  EMAIL_TRANSPORT: 'relayfix',
  RELAYFIX_TOKEN: TOKEN,
  EMAIL_FROM: 'drobek <no-reply@drobek.app>',
};

const delivered: { message: EmailTransportMessage; token: string }[] = [];

const relayfix = defineModule<Record<string, never>>({
  name: 'relayfix',
  version: '1.0.0',
  contract: '^1.2',
  skill: { useWhen: 'a test needs an e-mail transport module', markdown: '# relayfix\n' },
  configSchema: z.object({}),
  configDefaults: {},
  requires: ['email'],
  contributes: {
    'email.transport': defineEmailTransport({
      id: 'relayfix',
      label: 'Fixture relay',
      secrets: ['RELAYFIX_TOKEN'],
      async send(message, { secrets }) {
        delivered.push({ message, token: secrets.RELAYFIX_TOKEN });
      },
    }),
  },
});

let pg: PGlite;
let rt: ModuleRuntime;
let app: PlatformApp;
const HOST = 'shop--preview.apps.localhost:3041';

function post(path: string, body: unknown): PlatformRequest {
  const headers: Record<string, string> = { host: HOST, origin: `http://${HOST}`, 'x-drobek-sdk': '1', 'content-type': 'application/json' };
  const raw = Buffer.from(JSON.stringify(body));
  return { method: 'POST', path, query: '', header: (n) => headers[n.toLowerCase()] ?? null, headers: () => headers, clientIp: '203.0.113.9', readBody: async () => raw };
}

beforeAll(async () => {
  pg = new PGlite();
  const d = drizzle(pg, { schema });
  await migrate(d, { migrationsFolder: CORE_MIGRATIONS, migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
  const db = d as unknown as DB;
  setDbForTests(db);
  const [owner] = await d.insert(users).values({ email: 'owner@example.com' }).returning();
  const [ws] = await d.insert(workspaces).values({ kind: 'team', slug: 'relay-ws', name: 'Relay' }).returning();
  await d.insert(memberships).values({ userId: owner.id, workspaceId: ws.id, role: 'editor' });
  const [a] = await d.insert(apps).values({ workspaceId: ws.id, slug: 'shop', name: 'Shop' }).returning();
  app = { id: a.id, slug: a.slug, workspaceId: ws.id };
  rt = await loadModuleRuntime({
    env: ENV,
    log: noopLogger,
    modules: [email, relayfix],
    skillsDir: null,
    deps: {
      db: () => db,
      rateLimit: memoryRateLimiter(),
      principal: async () => ({ kind: 'user', id: 'eu_1', email: 'ana@example.com', role: 'user' }),
      mailGuard: memoryMailGuard({ hourlyMax: 100, pauseMinutes: 1 }, noopLogger),
      requestStats: () => undefined,
    },
  });
});

afterEach(() => {
  delivered.length = 0;
  vi.unstubAllEnvs();
});

afterAll(async () => {
  resetEmailTransportForTests();
  setDbForTests(null);
  await pg.close();
});

describe('EMAIL_TRANSPORT=<a module transport id>', () => {
  it('a dashboard sign-in code goes out through the module transport, with its env secret', async () => {
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    const logs = [vi.spyOn(console, 'log').mockImplementation(() => undefined), vi.spyOn(console, 'info').mockImplementation(() => undefined)];
    await sendLoginCodeEmail({ email: 'ana@example.com', code: 'XYZ789' });
    expect(delivered).toHaveLength(1);
    const [{ message, token }] = delivered;
    expect(token).toBe(TOKEN);
    expect(message.to).toBe('ana@example.com');
    expect(message.from).toEqual({ name: 'drobek', address: 'no-reply@drobek.app' });
    expect(message.text).toContain('XYZ789');
    expect(message.html).toContain('XYZ789');
    const logged = JSON.stringify(logs.flatMap((s) => s.mock.calls));
    expect(logged).toContain('login code sent');
    expect(logged).not.toContain(TOKEN);
  });

  it("the email module's notifyAdmins goes out through the module transport", async () => {
    const res = await rt.handle(post('/__drobek/v1/email/notify-admins', { subject: 'Low stock', text: 'Only 2 left.' }), app);
    expect(res.status, String(res.body)).toBe(200);
    expect(JSON.parse(String(res.body))).toEqual({ sent: 1 });
    expect(delivered).toHaveLength(1);
    const [{ message, token }] = delivered;
    expect(token).toBe(TOKEN);
    expect(message.to).toBe('owner@example.com');
    expect(message.subject).toBe('[Shop] Low stock');
    expect(message.from.address).toBe('no-reply@drobek.app');
    expect(message.text).toContain('Only 2 left.');
    expect(message.html).toContain('Only 2 left.');
  });
});
