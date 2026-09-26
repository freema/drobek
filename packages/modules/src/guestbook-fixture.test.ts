/**
 * NSO-345: the guestbook fixture (test-fixtures/drobek-module-guestbook)
 * loaded from a DROBEK_MODULES_DIR through the whole runtime path — lock
 * check, host peers, lint, migrations on PGlite, routes through the
 * production pipeline, the slot contribution and the runtime summary that
 * /healthz serves. EXT-09 installs the same fixture into the image.
 */
import { rmSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { apps, workspaces, setDbForTests, type DB } from '@drobek/db';
import { noopLogger, type Logger } from '@drobek/core';
import { defineModule, type AnyModule } from './contract.js';
import { loadModuleRuntime, moduleJournalTable, type ModuleRuntime } from './runtime.js';
import { createModuleTestContext } from './testing.js';
import { freshDb, type TestDb } from './test/db.js';
import { GUESTBOOK_FIXTURE, installDirModule, tempModulesDir } from './test/modules-dir.js';

const hello = defineModule({
  name: 'hello',
  version: '1.0.0',
  contract: '^1.1',
  skill: { useWhen: 'a test needs the greeter slot', markdown: '# hello\n' },
  configSchema: z.object({}),
  configDefaults: {},
  slots: {
    'hello.greeter': {
      schema: z.object({ id: z.string(), greet: z.custom<(n: string) => string>((v) => typeof v === 'function') }),
      unique: 'id',
      description: 'greeters',
    },
  },
});

let dir: string;
let pg: PGlite;
let db: TestDb;
let appId: string;
let runtime: ModuleRuntime;
let guestbook: AnyModule;
const ready: Record<string, unknown>[] = [];

beforeAll(async () => {
  dir = tempModulesDir();
  installDirModule(dir, { name: 'guestbook', from: GUESTBOOK_FIXTURE });
  ({ db, pg } = await freshDb());
  const log: Logger = {
    ...noopLogger,
    info: (msg, meta) => {
      if (msg === 'platform modules ready') ready.push(meta ?? {});
    },
  };
  runtime = await loadModuleRuntime({
    env: { NODE_ENV: 'test', DROBEK_MODULES: 'hello,guestbook' },
    modulesDir: dir,
    importer: async (pkg) => (pkg === 'drobek-module-hello' ? hello : null),
    skillsDir: null,
    log,
    migrate: (folder, table) =>
      migrate(db, { migrationsFolder: folder, migrationsTable: table, migrationsSchema: 'drizzle' }) as Promise<void>,
  });
  guestbook = runtime.get('guestbook')!;
  const [ws] = await db.insert(workspaces).values({ kind: 'team', slug: 'gb-ws', name: 'GB' }).returning();
  const [app] = await db.insert(apps).values({ workspaceId: ws.id, slug: 'gb-app' }).returning();
  appId = app.id;
}, 60_000);

afterAll(async () => {
  setDbForTests(null as never);
  await pg.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the guestbook fixture from DROBEK_MODULES_DIR', () => {
  it('summarizes the modules without paths (the /healthz and /api/version list) and logs it at start', () => {
    const summary = [
      { name: 'hello', version: '1.0.0', source: 'builtin', contract: '^1.1' },
      { name: 'guestbook', version: '1.0.0', source: 'dir', contract: '^1.1' },
    ];
    expect(runtime.summary()).toEqual(summary);
    expect(ready[0]?.modules).toEqual(summary);
    expect(JSON.stringify(runtime.summary())).not.toContain(dir);
  });

  it('applied its migrations under its own journal', async () => {
    const r = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM drizzle.${moduleJournalTable('guestbook')}`);
    expect(r.rows[0].n).toBe(1);
  });

  it('serves its routes through the production pipeline: sign, list, closed', async () => {
    const t = createModuleTestContext(guestbook, { db: db as unknown as DB, app: { id: appId } });
    const signed = await t.request('POST', '/sign', { body: { name: 'Ada', message: 'Lovely' } });
    expect(signed.status).toBe(200);
    expect(signed.body).toEqual({ entries: 1 });
    const list = await t.request('GET', '/');
    expect(list.body).toMatchObject({ title: 'Guestbook', open: true, entries: [{ name: 'Ada', message: 'Lovely' }] });

    const closed = createModuleTestContext(guestbook, { db: db as unknown as DB, app: { id: appId }, config: { open: false } });
    const refused = await closed.request('POST', '/sign', { body: { name: 'Bob', message: 'Hi' } });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: 'guestbook_closed' });
  });

  it('contributes its greeter to hello.greeter and its error code to the catalogue', () => {
    const greeters = runtime.contributions<{ id: string; greet: (n: string) => string }>('hello.greeter');
    expect(greeters.map((g) => g.id)).toEqual(['guestbook']);
    expect(greeters[0].greet('Ada')).toContain('Ada');
    expect(runtime.errorCatalogue().map((s) => s.module)).toEqual(['guestbook']);
  });

  it('is in the SDK bundle', () => {
    expect(runtime.sdk.modules).toContain('guestbook');
    expect(runtime.sdk.js.toString('utf8')).toContain('/sign');
  });
});
