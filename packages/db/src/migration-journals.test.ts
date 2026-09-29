/**
 * Every migrations folder in the repository (core, built-in modules, the
 * example and template modules, test fixtures) is consistent: journal
 * entries ascend by index and `when`, each tag starts with its index, each
 * entry has its .sql file and each .sql file an entry. Core also keeps one
 * snapshot per entry, chained by `prevId`. Guards CLAUDE.md rule 7 after a
 * merge, before a broken folder reaches a server's start-up migration.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CORE = join(ROOT, 'packages/db/drizzle/migrations');

interface Entry {
  idx: number;
  when: number;
  tag: string;
}

function subfolders(dir: string, depth: 1 | 2): string[] {
  if (!existsSync(dir)) return [];
  const direct = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(dir, d.name));
  return depth === 1 ? direct : direct.flatMap((d) => subfolders(d, 1));
}

function migrationFolders(): string[] {
  const candidates = [
    CORE,
    ...subfolders(join(ROOT, 'modules'), 1).map((d) => join(d, 'migrations')),
    ...subfolders(join(ROOT, 'examples'), 1).map((d) => join(d, 'migrations')),
    join(ROOT, 'packages/create-drobek-module/template/migrations'),
    ...subfolders(join(ROOT, 'packages/modules/test-fixtures'), 1).map((d) => join(d, 'migrations')),
  ];
  return candidates.filter((d) => existsSync(join(d, 'meta/_journal.json')));
}

function journal(dir: string): Entry[] {
  return (JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8')) as { entries: Entry[] }).entries;
}

describe('migration journals', () => {
  const folders = migrationFolders();

  it('finds core and the module folders', () => {
    expect(folders).toContain(CORE);
    expect(folders.length).toBeGreaterThan(5);
  });

  for (const dir of folders) {
    const name = relative(ROOT, dir);

    it(`${name}: entries ascend and match the .sql files`, () => {
      const entries = journal(dir);
      expect(entries.length).toBeGreaterThan(0);
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        expect(e.tag.startsWith(`${String(e.idx).padStart(4, '0')}_`), `${e.tag} starts with its idx ${e.idx}`).toBe(true);
        if (i > 0) {
          expect(e.idx, `${e.tag} idx after ${entries[i - 1].tag}`).toBeGreaterThan(entries[i - 1].idx);
          expect(e.when, `${e.tag} when after ${entries[i - 1].tag}`).toBeGreaterThan(entries[i - 1].when);
        }
      }
      const sqlFiles = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
      expect(sqlFiles).toEqual(entries.map((e) => `${e.tag}.sql`).sort());
    });
  }

  it('core: one snapshot per entry, chained by prevId', () => {
    const entries = journal(CORE);
    const snapshots = readdirSync(join(CORE, 'meta')).filter((f) => f.endsWith('_snapshot.json')).sort();
    expect(snapshots).toEqual(entries.map((e) => `${String(e.idx).padStart(4, '0')}_snapshot.json`).sort());
    let prev = '00000000-0000-0000-0000-000000000000';
    for (const e of entries) {
      const file = `${String(e.idx).padStart(4, '0')}_snapshot.json`;
      const snap = JSON.parse(readFileSync(join(CORE, 'meta', file), 'utf8')) as { id: string; prevId: string };
      expect(snap.prevId, `${file} prevId`).toBe(prev);
      prev = snap.id;
    }
  });
});
