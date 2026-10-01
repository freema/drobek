import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users, workspaces } from '@drobek/db';
import { createApp, createVersion, versionReadiness, versionSources, getVersion, type Actor } from './index.js';
import { freshDb } from './test/db.js';

let close: () => Promise<void>;
let appId: string;
let actor: Actor;

beforeAll(async () => {
  const t = await freshDb();
  close = () => t.pg.close();
  const [u] = await t.db.insert(users).values({ email: 'owner@example.test' }).returning();
  const [w] = await t.db.insert(workspaces).values({ kind: 'personal', slug: 'owner', name: 'Owner' }).returning();
  actor = { userId: u.id, kind: 'agent' };
  appId = (await createApp({ workspaceId: w.id, slug: 'ready-app', actor })).id;
});
afterAll(async () => close());

const HEAD = '<meta name="description" content="A ready app."><link rel="icon" href="/favicon.svg">';

describe('versionReadiness', () => {
  it('a compiled version with a titled, described index.html with an icon is ready with no warnings', async () => {
    const v = await createVersion(appId, [{ path: 'index.html', content: `<head><title>Ready</title>${HEAD}</head>` }], {
      actor,
      compile: { status: 'ok' },
    });
    expect(await versionReadiness(appId, { number: v.number })).toEqual({
      version: v.number,
      report: { ready: true, blocking: [], warnings: [] },
    });
  });

  it('runs the checks over the stored source files (not the built ones)', async () => {
    const v = await createVersion(
      appId,
      [
        { path: 'index.html', content: `<head>${HEAD}</head><body><div id="root"></div></body>` },
        { path: 'index.html', content: '<head><title>built</title></head>', kind: 'built' },
      ],
      { actor, compile: { status: 'ok' } }
    );
    const r = await versionReadiness(appId, { id: v.id });
    expect(r?.report.ready).toBe(true);
    expect(r?.report.warnings.map((w) => w.code)).toEqual(['missing_title']);
  });

  it('a version that did not compile is blocked by its stored compile errors', async () => {
    const v = await createVersion(appId, [{ path: 'src/main.ts', content: 'let =' }], {
      actor,
      compile: { status: 'error', errors: [{ code: 'build_error', file: 'src/main.ts', line: 1, column: 4, text: 'Expected identifier' }] },
    });
    const r = await versionReadiness(appId, { number: v.number });
    expect(r?.report).toEqual({
      ready: false,
      blocking: [{ code: 'build_error', file: 'src/main.ts', line: 1, message: 'Expected identifier', hint: expect.stringContaining('Fix the file') }],
      warnings: [],
    });
  });

  it('an error version without stored errors is still blocked', async () => {
    const v = await createVersion(appId, [{ path: 'a.txt', content: 'x' }], { actor, compile: { status: 'error', errors: null } });
    const r = await versionReadiness(appId, { number: v.number });
    expect(r?.report.ready).toBe(false);
    expect(r?.report.blocking.map((b) => b.code)).toEqual(['compile_error']);
  });

  it('answers null for a version that does not exist', async () => {
    expect(await versionReadiness(appId, { number: 999 })).toBeNull();
  });

  it('versionSources decodes text files and keeps binary ones as bytes', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const v = await createVersion(appId, [{ path: 'a.css', content: 'body{}' }, { path: 'logo.png', content: png }], { actor });
    const files = await versionSources((await getVersion(appId, { id: v.id }))!);
    expect(files.get('a.css')).toBe('body{}');
    expect(Buffer.isBuffer(files.get('logo.png'))).toBe(true);
  });
});
