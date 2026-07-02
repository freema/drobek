import { describe, expect, it } from 'vitest';
import { isSuperAdmin } from './super-admin.server';

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
});
