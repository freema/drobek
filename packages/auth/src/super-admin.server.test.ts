import { describe, expect, it, vi } from 'vitest';
import { isSuperAdmin, superAdminEmails } from './super-admin.server.js';

describe('isSuperAdmin', () => {
  it('matches after normalization (trim + lowercase) on both sides', () => {
    expect(isSuperAdmin('admin@drobek.app', 'admin@drobek.app')).toBe(true);
    expect(isSuperAdmin(' Admin@Drobek.APP ', 'admin@drobek.app')).toBe(true);
    expect(isSuperAdmin('admin@drobek.app', '  ADMIN@drobek.app  ')).toBe(true);
  });

  it('does not match a different email', () => {
    expect(isSuperAdmin('user@drobek.app', 'admin@drobek.app')).toBe(false);
  });

  it('empty/unset SUPERADMIN_EMAIL means nobody is super-admin', () => {
    expect(isSuperAdmin('admin@drobek.app', '')).toBe(false);
    expect(isSuperAdmin('admin@drobek.app', '   ')).toBe(false);
    expect(isSuperAdmin('admin@drobek.app', undefined)).toBe(false);
    expect(isSuperAdmin('', '')).toBe(false);
  });

  // U3 amendment (2026-07-02): comma-separated list of super-admin emails.
  it('matches ANY entry of a comma-separated list', () => {
    const list = 'grasl.t@centrum.cz,freema25@gmail.com';
    expect(isSuperAdmin('grasl.t@centrum.cz', list)).toBe(true);
    expect(isSuperAdmin('freema25@gmail.com', list)).toBe(true);
    expect(isSuperAdmin('other@drobek.app', list)).toBe(false);
  });

  it('normalizes list entries (spaces around commas, mixed case)', () => {
    const list = '  Grasl.T@Centrum.CZ , FREEMA25@gmail.com ';
    expect(isSuperAdmin('grasl.t@centrum.cz', list)).toBe(true);
    expect(isSuperAdmin(' Freema25@GMAIL.com ', list)).toBe(true);
  });

  it('ignores empty entries (leading/trailing/double commas)', () => {
    expect(isSuperAdmin('a@x.cz', ',a@x.cz,,b@y.com,')).toBe(true);
    expect(isSuperAdmin('b@y.com', ',a@x.cz,,b@y.com,')).toBe(true);
    // A list of ONLY empty entries means nobody is super-admin.
    expect(isSuperAdmin('a@x.cz', ', ,,  ,')).toBe(false);
    // An empty candidate email never matches an empty entry.
    expect(isSuperAdmin('', 'a@x.cz,,b@y.com')).toBe(false);
  });

  it('keeps the single-value form working', () => {
    expect(isSuperAdmin('admin@drobek.app', 'admin@drobek.app')).toBe(true);
    expect(isSuperAdmin('user@drobek.app', 'admin@drobek.app')).toBe(false);
  });

  it('lists every configured address, normalized and deduped (abuse report e-mails)', () => {
    expect(superAdminEmails(' A@x.cz , ,b@y.com,a@x.cz ')).toEqual(['a@x.cz', 'b@y.com']);
    expect(superAdminEmails('')).toEqual([]);
    // `undefined` falls back to process.env — pin it (a local .env loaded by
    // the Taskfile carries a real SUPERADMIN_EMAIL).
    vi.stubEnv('SUPERADMIN_EMAIL', '');
    try {
      expect(superAdminEmails(undefined)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
