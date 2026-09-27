/**
 * NSO-340 — the gallery's pure rules (switch, description, page size, search
 * text, sort, page number, cursor, effective state, row visibility) and migration 0022's `published_at` backfill against a
 * database in the 0021 shape.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import * as schema from '@drobek/db/schema';
import {
  GALLERY_DESCRIPTION_MAX,
  GALLERY_PAGE_MAX,
  GALLERY_PAGE_NUMBER_MAX,
  GALLERY_PAGE_SIZE,
  GALLERY_QUERY_MAX,
  decodeGalleryCursor,
  encodeGalleryCursor,
  galleryEnabled,
  galleryLikePattern,
  galleryPageNumber,
  galleryPageSize,
  galleryQuery,
  gallerySort,
  galleryState,
  isGalleryVisible,
  normalizeGalleryDescription,
} from './gallery.js';
import { migrateTo, migrationsUpTo } from './test/db.js';

describe('galleryEnabled', () => {
  it('is off unless GALLERY_ENABLED says yes', () => {
    expect(galleryEnabled({})).toBe(false);
    for (const v of ['', '0', 'false', 'no', 'off', 'maybe']) expect(galleryEnabled({ GALLERY_ENABLED: v }), v).toBe(false);
    for (const v of ['1', 'true', 'TRUE', ' yes ', 'on']) expect(galleryEnabled({ GALLERY_ENABLED: v }), v).toBe(true);
  });
});

describe('normalizeGalleryDescription', () => {
  it('collapses whitespace and control characters into one line of plain text', () => {
    expect(normalizeGalleryDescription('  Shift\r\nplanner\tfor   teams.\u2028Free. ')).toEqual({
      ok: true,
      value: 'Shift planner for teams. Free.',
    });
    expect(normalizeGalleryDescription('a\u0000b\u007fc')).toEqual({ ok: true, value: 'a b c' });
  });

  it('refuses empty, non-string and over-long descriptions (counted in characters, not bytes)', () => {
    for (const raw of ['', '  \n ', null, undefined, 42]) expect(normalizeGalleryDescription(raw).ok).toBe(false);
    expect(normalizeGalleryDescription('ž'.repeat(GALLERY_DESCRIPTION_MAX)).ok).toBe(true);
    const long = normalizeGalleryDescription('x'.repeat(GALLERY_DESCRIPTION_MAX + 1));
    expect(long).toMatchObject({ ok: false, message: expect.stringContaining('160') });
  });
});

describe('galleryPageSize', () => {
  it('defaults to 24 and clamps to 1..48', () => {
    expect(galleryPageSize(null)).toBe(GALLERY_PAGE_SIZE);
    expect(galleryPageSize('')).toBe(GALLERY_PAGE_SIZE);
    expect(galleryPageSize('abc')).toBe(GALLERY_PAGE_SIZE);
    expect(galleryPageSize('10')).toBe(10);
    expect(galleryPageSize('0')).toBe(1);
    expect(galleryPageSize('500')).toBe(GALLERY_PAGE_MAX);
    expect(galleryPageSize('7.9')).toBe(7);
  });
});

describe('galleryQuery / galleryLikePattern', () => {
  it('trims, cuts to 100 characters and treats empty as no search', () => {
    expect(galleryQuery(null)).toBeNull();
    expect(galleryQuery('   ')).toBeNull();
    expect(galleryQuery('  Shift plan ')).toBe('Shift plan');
    expect(galleryQuery('ž'.repeat(GALLERY_QUERY_MAX + 20))).toBe('ž'.repeat(GALLERY_QUERY_MAX));
  });

  it('escapes the LIKE wildcards and the escape character', () => {
    expect(galleryLikePattern('shift')).toBe('%shift%');
    expect(galleryLikePattern('100%')).toBe('%100\\%%');
    expect(galleryLikePattern('a_b')).toBe('%a\\_b%');
    expect(galleryLikePattern('c:\\x')).toBe('%c:\\\\x%');
    expect(galleryLikePattern("'; DROP TABLE apps; --")).toBe("%'; DROP TABLE apps; --%");
  });
});

describe('gallerySort / galleryPageNumber', () => {
  it('sorts by name only when asked; anything else is newest first', () => {
    expect(gallerySort('name')).toBe('name');
    expect(gallerySort(' NAME ')).toBe('name');
    for (const v of [null, '', 'new', 'oldest', 'name;']) expect(gallerySort(v), String(v)).toBe('new');
  });

  it('absent = no page; an invalid page is 1; a huge one is clamped', () => {
    expect(galleryPageNumber(null)).toBeNull();
    expect(galleryPageNumber('')).toBeNull();
    expect(galleryPageNumber('3')).toBe(3);
    expect(galleryPageNumber('2.9')).toBe(2);
    for (const v of ['0', '-4', 'abc', 'NaN', 'Infinity', '0.5']) expect(galleryPageNumber(v), v).toBe(1);
    expect(galleryPageNumber('1e12')).toBe(GALLERY_PAGE_NUMBER_MAX);
  });
});

describe('isGalleryVisible', () => {
  const row = {
    galleryListed: true,
    galleryDescription: 'Hi.',
    galleryHiddenAt: null,
    publishedVersionId: 'v1',
    publishedAt: new Date(),
    lockedReason: null,
    visibility: 'public',
    deletedAt: null,
  };
  it('is true only for listed, published, public, not taken down, not deleted, not hidden', () => {
    expect(isGalleryVisible(row)).toBe(true);
    expect(isGalleryVisible({ ...row, galleryListed: false })).toBe(false);
    expect(isGalleryVisible({ ...row, galleryDescription: null })).toBe(false);
    expect(isGalleryVisible({ ...row, publishedVersionId: null })).toBe(false);
    expect(isGalleryVisible({ ...row, publishedAt: null })).toBe(false);
    expect(isGalleryVisible({ ...row, visibility: 'password' })).toBe(false);
    expect(isGalleryVisible({ ...row, lockedReason: 'spam' })).toBe(false);
    expect(isGalleryVisible({ ...row, deletedAt: new Date() })).toBe(false);
    expect(isGalleryVisible({ ...row, galleryHiddenAt: new Date() })).toBe(false);
  });
});

describe('gallery cursor', () => {
  it('round-trips the publish time and slug; anything else decodes to null', () => {
    const c = { publishedAt: new Date('2026-09-26T10:11:12.345Z'), slug: 'shift-planner' };
    const token = encodeGalleryCursor(c);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeGalleryCursor(token)).toEqual(c);
    for (const bad of [null, '', '!!', 'a'.repeat(200), Buffer.from('x.slug').toString('base64url'), Buffer.from('1.Bad Slug').toString('base64url')]) {
      expect(decodeGalleryCursor(bad), String(bad)).toBeNull();
    }
  });
});

describe('galleryState', () => {
  const base = {
    galleryListed: true,
    galleryDescription: 'Hi.',
    galleryHiddenAt: null,
    publishedVersionId: 'v1',
    lockedReason: null,
    visibility: 'public',
  };
  it('is visible only when listed, published, public, not taken down and not hidden', () => {
    expect(galleryState(base)).toEqual({ listed: true, description: 'Hi.', hiddenByAdmin: false, visible: true });
    expect(galleryState({ ...base, galleryListed: false }).visible).toBe(false);
    expect(galleryState({ ...base, publishedVersionId: null }).visible).toBe(false);
    expect(galleryState({ ...base, visibility: 'password' }).visible).toBe(false);
    expect(galleryState({ ...base, lockedReason: 'spam' }).visible).toBe(false);
    expect(galleryState({ ...base, galleryHiddenAt: new Date() })).toMatchObject({ hiddenByAdmin: true, visible: false });
  });
});

describe('migration 0022 (gallery)', () => {
  const open: PGlite[] = [];
  afterAll(async () => {
    for (const pg of open) await pg.close();
  });

  it('backfills published_at from the newest app.publish audit row, else the published version', async () => {
    const pg = new PGlite();
    open.push(pg);
    const db = drizzle(pg, { schema });
    await migrateTo(db, migrationsUpTo(21));
    await pg.exec(`
      INSERT INTO users (id, email) VALUES ('u1', 'o@example.test');
      INSERT INTO workspaces (id, kind, slug, name) VALUES ('w1', 'personal', 'owner', 'Owner');
      INSERT INTO apps (id, workspace_id, slug) VALUES ('a1', 'w1', 'audited'), ('a2', 'w1', 'no-audit'), ('a3', 'w1', 'unpublished');
      INSERT INTO app_versions (id, app_id, number, actor_kind, compile_status, created_at) VALUES
        ('v1', 'a1', 1, 'agent', 'ok', '2026-09-01 08:00:00'),
        ('v2', 'a2', 1, 'agent', 'ok', '2026-09-02 09:30:00.123456'),
        ('v3', 'a3', 1, 'agent', 'ok', '2026-09-03 10:00:00');
      UPDATE apps SET published_version_id = 'v1' WHERE id = 'a1';
      UPDATE apps SET published_version_id = 'v2' WHERE id = 'a2';
      INSERT INTO audit_log (id, workspace_id, actor_kind, action, subject_type, target, created_at) VALUES
        ('l1', 'w1', 'agent', 'app.publish', 'app', 'audited', '2026-09-05 12:00:00'),
        ('l2', 'w1', 'agent', 'app.publish', 'app', 'audited', '2026-09-06 13:00:00.987654'),
        ('l3', 'w1', 'agent', 'app.unpublish', 'app', 'audited', '2026-09-07 13:00:00');
    `);
    await migrateTo(db);
    const res = await db.execute<{ id: string; published_at: string | null; gallery_listed: boolean }>(
      sql`SELECT id, published_at::text AS published_at, gallery_listed FROM apps ORDER BY id`
    );
    expect(res.rows).toEqual([
      { id: 'a1', published_at: '2026-09-06 13:00:00.987', gallery_listed: false },
      { id: 'a2', published_at: '2026-09-02 09:30:00.123', gallery_listed: false },
      { id: 'a3', published_at: null, gallery_listed: false },
    ]);
  });
});
