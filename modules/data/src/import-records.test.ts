/**
 * The records authority's `importRecords` (NSO-392 — the sync module's
 * batch): replace and upsert over PGlite, all or nothing (a bad record, a
 * duplicate key or a quota leaves the collection as it was), the schema and
 * the record size checked for every record, other collections untouched.
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apps, workspaces, type DB } from '@drobek/db';
import * as schema from '@drobek/db/schema';
import { isModuleError, type RecordsView } from '@drobek/modules';
import data, { dataConfigSchema, dataRecords, recordsAuthority, type DataConfig } from './index.js';

const CORE_MIGRATIONS = fileURLToPath(new URL('../../../packages/db/drizzle/migrations', import.meta.url));

let pg: PGlite;
let db: DB;
let appId: string;
let workspaceId: string;
let limits: Record<string, number> = {};

const CONFIG = dataConfigSchema.parse({
  collections: {
    players: {
      rules: { read: 'public', create: 'none', update: 'none', delete: 'none' },
      schema: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'integer' }, name: { type: 'string' }, points: { type: 'number' } } },
    },
    notes: { rules: { read: 'public', create: 'public' } },
  },
});

beforeAll(async () => {
  pg = new PGlite();
  const d = drizzle(pg, { schema });
  await migrate(d, { migrationsFolder: CORE_MIGRATIONS, migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
  await migrate(d, { migrationsFolder: data.migrations!.folder, migrationsTable: '__drizzle_migrations_mod_data', migrationsSchema: 'drizzle' });
  db = d as unknown as DB;
  const [w] = await d.insert(workspaces).values({ kind: 'team', slug: 'imp-ws', name: 'Import' }).returning();
  workspaceId = w.id;
  const [a] = await d.insert(apps).values({ workspaceId, slug: 'league', name: 'League' }).returning();
  appId = a.id;
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  limits = {};
  await db.delete(dataRecords);
});

const view = (): RecordsView<DataConfig> => ({
  app: { id: appId, slug: 'league', workspaceId },
  config: CONFIG,
  db,
  log: { debug() {}, info() {}, warn() {}, error() {} },
  limits: async () => limits,
});

async function stored(collection = 'players') {
  const rows = await db
    .select()
    .from(dataRecords)
    .where(and(eq(dataRecords.appId, appId), eq(dataRecords.collection, collection)))
    .orderBy(asc(dataRecords.createdAt));
  return rows.map((r) => ({ ...r.doc, rowId: r.id, owner: r.ownerId, created: r.createdAt.getTime() }));
}

const importRecords = (records: Record<string, unknown>[], opts: { mode: 'replace' | 'upsert'; key?: string }, collection = 'players') =>
  recordsAuthority.importRecords!(view(), collection, records, opts);

describe('importRecords — replace', () => {
  it('the collection holds exactly the batch afterwards (in order, no owner); `_` keys are dropped', async () => {
    await importRecords([{ id: 1, name: 'Old' }], { mode: 'replace' });
    const r = await importRecords(
      [
        { id: 2, name: 'Ada', points: 10, _owner: 'spoof' },
        { id: 3, name: 'Bo', points: 7 },
      ],
      { mode: 'replace' }
    );
    expect(r).toEqual({ inserted: 2, updated: 0, deleted: 1 });
    const rows = await stored();
    expect(rows.map((x) => [x.rowId.length > 0, x.owner, (x as Record<string, unknown>).name])).toEqual([
      [true, null, 'Ada'],
      [true, null, 'Bo'],
    ]);
    expect(rows.some((x) => '_owner' in x && (x as Record<string, unknown>)._owner === 'spoof')).toBe(false);
  });

  it('an empty batch empties the collection; other collections stay', async () => {
    await importRecords([{ text: 'keep' }], { mode: 'replace' }, 'notes');
    await importRecords([{ id: 1, name: 'A' }], { mode: 'replace' });
    expect(await importRecords([], { mode: 'replace' })).toEqual({ inserted: 0, updated: 0, deleted: 1 });
    expect(await stored()).toEqual([]);
    expect(await stored('notes')).toHaveLength(1);
  });
});

describe('importRecords — upsert', () => {
  it('a record with the same key replaces the stored fields (keeping _created_at), new ones are added, the rest stay', async () => {
    await importRecords(
      [
        { id: 1, name: 'Ada', points: 1 },
        { id: 2, name: 'Bo', points: 2 },
      ],
      { mode: 'replace' }
    );
    const before = await stored();
    const r = await importRecords(
      [
        { id: 2, name: 'Bo', points: 20 },
        { id: 3, name: 'Cy' },
      ],
      { mode: 'upsert', key: 'id' }
    );
    expect(r).toEqual({ inserted: 1, updated: 1, deleted: 0 });
    const after = await stored();
    expect(after.map((x) => [(x as Record<string, unknown>).id === undefined, (x as Record<string, unknown>).name, (x as Record<string, unknown>).points])).toEqual([
      [false, 'Ada', 1],
      [false, 'Bo', 20],
      [false, 'Cy', undefined],
    ]);
    const bo = after.find((x) => (x as Record<string, unknown>).name === 'Bo')!;
    expect(bo.created).toBe(before.find((x) => (x as Record<string, unknown>).name === 'Bo')!.created);
  });

  it('keys compare as JSON: the string "7" is not the number 7', async () => {
    await importRecords([{ key: 7, v: 'num' }], { mode: 'replace' }, 'notes');
    const r = await importRecords([{ key: '7', v: 'str' }], { mode: 'upsert', key: 'key' }, 'notes');
    expect(r).toEqual({ inserted: 1, updated: 0, deleted: 0 });
    expect(await stored('notes')).toHaveLength(2);
  });

  it('needs a key; a missing, non-scalar or duplicated key refuses the whole batch', async () => {
    await expect(importRecords([{ id: 1, name: 'A' }], { mode: 'upsert' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(importRecords([{ id: 1, name: 'A' }, { name: 'B' }], { mode: 'upsert', key: 'id' })).rejects.toMatchObject({
      code: 'validation_failed',
      details: { index: 1 },
    });
    await expect(importRecords([{ id: 1, name: 'A' }, { id: 1, name: 'B' }], { mode: 'upsert', key: 'id' })).rejects.toMatchObject({
      code: 'validation_failed',
      details: { index: 1 },
    });
    expect(await stored()).toEqual([]);
  });
});

describe('importRecords — all or nothing', () => {
  it('a record that fails the schema → validation_failed naming its index; the old records stay', async () => {
    await importRecords([{ id: 1, name: 'Keep' }], { mode: 'replace' });
    const err = await importRecords(
      [
        { id: 2, name: 'Ok' },
        { id: 'three', name: 'Bad' },
      ],
      { mode: 'replace' }
    ).catch((e: unknown) => e);
    expect(isModuleError(err) && err.code).toBe('validation_failed');
    expect((err as Error).message).toMatch(/^Record 1: /);
    expect((await stored()).map((x) => (x as Record<string, unknown>).name)).toEqual(['Keep']);
  });

  it('the app quota is checked for the state after the batch: replacing within the limit passes, beyond it nothing changes', async () => {
    limits = { DATA_MAX_DOCS_PER_APP: 3 };
    await importRecords([{ text: 'n' }], { mode: 'replace' }, 'notes');
    await importRecords([{ id: 1, name: 'A' }, { id: 2, name: 'B' }], { mode: 'replace' });
    // 1 note + 2 players replaced by 2 → 3: fits.
    await importRecords([{ id: 3, name: 'C' }, { id: 4, name: 'D' }], { mode: 'replace' });
    await expect(importRecords([{ id: 5, name: 'E' }, { id: 6, name: 'F' }, { id: 7, name: 'G' }], { mode: 'replace' })).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    expect((await stored()).map((x) => (x as Record<string, unknown>).name)).toEqual(['C', 'D']);
    await expect(importRecords([{ id: 5, name: 'E' }], { mode: 'upsert', key: 'id' })).rejects.toMatchObject({ code: 'quota_exceeded' });
  });

  it('a record over DATA_MAX_DOC_BYTES refuses the batch', async () => {
    limits = { DATA_MAX_DOC_BYTES: 64 };
    await expect(importRecords([{ id: 1, name: 'x'.repeat(100) }], { mode: 'replace' })).rejects.toMatchObject({ code: 'validation_failed', details: { index: 0 } });
  });

  it('an undeclared collection → not_found', async () => {
    await expect(importRecords([], { mode: 'replace' }, 'ghosts')).rejects.toMatchObject({ code: 'not_found' });
  });
});
