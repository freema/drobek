/**
 * NSO-340 — the gallery's pure rules (switch, description, page size, cursor,
 * effective state) and migration 0022's `published_at` backfill against a
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
  GALLERY_PAGE_SIZE,
  decodeGalleryCursor,
  encodeGalleryCursor,
  galleryEnabled,
  galleryPageSize,
  galleryState,
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
