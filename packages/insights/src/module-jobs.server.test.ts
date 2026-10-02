/**
 * A failed module job run in get_logs `runtime` (PGlite, migration
 * 0030) — its own type with module and job, redacted, deduped per module, job
 * and message — while a browser error's entry keeps exactly its shape.
 */
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appErrors, apps, workspaces } from '@drobek/db';
import { queryRuntimeLog } from './logs.server.js';
import { recordModuleJobFailure } from './module-jobs.server.js';
import { queryAppErrors } from './query.server.js';
import { dedupKey } from './sanitize.js';
import { freshDb, type TestDb } from './test/db.js';

let db: TestDb;
let pg: PGlite;
let appId: string;

beforeAll(async () => {
  ({ db, pg } = await freshDb());
  const [ws] = await db.insert(workspaces).values({ kind: 'team', slug: 'jobs-ws', name: 'Jobs' }).returning();
  const [a] = await db.insert(apps).values({ workspaceId: ws.id, slug: 'fantasy', name: 'Fantasy' }).returning();
  appId = a.id;
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await db.delete(appErrors);
});

describe('recordModuleJobFailure', () => {
  it('stores a module_job entry get_logs runtime shows with module and job, redacted and deduped', async () => {
    await recordModuleJobFailure({ appId, module: 'sync', job: 'import', message: 'GET https://api.example/players?api_key=sk_live_abcdef returned 503 for ops@example.com' });
    await recordModuleJobFailure({ appId, module: 'sync', job: 'import', message: 'GET https://api.example/players?api_key=sk_live_abcdef returned 503 for ops@example.com' });
    await recordModuleJobFailure({ appId, module: 'sync', job: 'scores', message: 'GET https://api.example/players?api_key=sk_live_abcdef returned 503 for ops@example.com' });
    const entries = await queryRuntimeLog(appId);
    expect(entries).toHaveLength(2);
    const imp = entries.find((e) => e.job === 'import')!;
    expect(imp).toMatchObject({ type: 'module_job', module: 'sync', job: 'import', count: 2, url: '', stack: null, file_hint: null });
    expect(imp.message).not.toContain('sk_live_abcdef');
    expect(imp.message).not.toContain('ops@example.com');
    expect(imp.message).toContain('returned 503');
    expect(entries.find((e) => e.job === 'scores')).toMatchObject({ module: 'sync', count: 1 });
    const overview = await queryAppErrors(appId);
    expect(overview.errors.map((e) => [e.type, e.module, e.job]).sort()).toEqual([
      ['module_job', 'sync', 'import'],
      ['module_job', 'sync', 'scores'],
    ]);
  });

  it('caps the message and never stores an empty one', async () => {
    await recordModuleJobFailure({ appId, module: 'sync', job: 'import', message: 'x '.repeat(2000) });
    await recordModuleJobFailure({ appId, module: 'sync', job: 'empty', message: '   ' });
    const entries = await queryRuntimeLog(appId);
    expect(entries.find((e) => e.job === 'import')!.message.length).toBeLessThanOrEqual(1001);
    expect(entries.find((e) => e.job === 'empty')!.message).toBe('the job failed');
  });

  it('a browser error keeps exactly its entry shape (no module / job keys)', async () => {
    const created = new Date();
    await db.insert(appErrors).values({
      appId,
      type: 'error',
      message: 'TypeError: x is undefined',
      stack: 'TypeError: x is undefined\n    at https://fantasy--preview.apps.example/assets/app.js:4:2',
      url: 'https://fantasy--preview.apps.example/',
      dedupKey: dedupKey('TypeError: x is undefined', null),
      createdAt: created,
    });
    const [entry] = await queryRuntimeLog(appId);
    expect(Object.keys(entry).sort()).toEqual(['count', 'file_hint', 'first_seen', 'last_seen', 'message', 'stack', 'type', 'url', 'version']);
    expect(entry).toMatchObject({
      type: 'error',
      url: 'https://fantasy--preview.apps.example/',
      version: null,
      file_hint: 'https://fantasy--preview.apps.example/assets/app.js:4:2',
    });
  });
});
