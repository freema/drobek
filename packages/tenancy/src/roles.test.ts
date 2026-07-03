import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_ROLES,
  decideWorkspaceAccess,
  higherRole,
  isWorkspaceRole,
  roleAtLeast,
  roleRank,
} from './roles.js';

describe('role union + ranking', () => {
  it('knows exactly the 3 membership roles (super-admin is NOT one)', () => {
    expect(WORKSPACE_ROLES).toEqual(['viewer', 'editor', 'workspace-admin']);
    expect(isWorkspaceRole('editor')).toBe(true);
    expect(isWorkspaceRole('super-admin')).toBe(false);
    expect(isWorkspaceRole('owner')).toBe(false);
    expect(isWorkspaceRole('')).toBe(false);
    expect(isWorkspaceRole(null)).toBe(false);
  });

  it('ranks viewer < editor < workspace-admin', () => {
    expect(roleRank('viewer')).toBeLessThan(roleRank('editor'));
    expect(roleRank('editor')).toBeLessThan(roleRank('workspace-admin'));
  });

  it('roleAtLeast follows the ranking (>= semantics)', () => {
    expect(roleAtLeast('viewer', 'viewer')).toBe(true);
    expect(roleAtLeast('viewer', 'editor')).toBe(false);
    expect(roleAtLeast('editor', 'viewer')).toBe(true);
    expect(roleAtLeast('editor', 'workspace-admin')).toBe(false);
    expect(roleAtLeast('workspace-admin', 'editor')).toBe(true);
    expect(roleAtLeast('workspace-admin', 'workspace-admin')).toBe(true);
  });

  it('higherRole picks the better of the two', () => {
    expect(higherRole('viewer', 'editor')).toBe('editor');
    expect(higherRole('workspace-admin', 'editor')).toBe('workspace-admin');
    expect(higherRole('viewer', 'viewer')).toBe('viewer');
  });
});

describe('decideWorkspaceAccess (requireWorkspaceRole decision core)', () => {
  it('allows a member at exactly the min role', () => {
    expect(
      decideWorkspaceAccess({
        membershipRole: 'editor',
        superAdmin: false,
        minRole: 'editor',
      })
    ).toEqual({ ok: true, effectiveRole: 'editor' });
  });

  it('allows a member above the min role, keeping their own role', () => {
    expect(
      decideWorkspaceAccess({
        membershipRole: 'workspace-admin',
        superAdmin: false,
        minRole: 'viewer',
      })
    ).toEqual({ ok: true, effectiveRole: 'workspace-admin' });
  });

  it('403s a member below the min role (viewer mutation acceptance)', () => {
    expect(
      decideWorkspaceAccess({
        membershipRole: 'viewer',
        superAdmin: false,
        minRole: 'workspace-admin',
      })
    ).toEqual({ ok: false, status: 403 });
    expect(
      decideWorkspaceAccess({
        membershipRole: 'editor',
        superAdmin: false,
        minRole: 'workspace-admin',
      })
    ).toEqual({ ok: false, status: 403 });
  });

  it('404s a non-member (workspace existence is not leaked)', () => {
    expect(
      decideWorkspaceAccess({
        membershipRole: null,
        superAdmin: false,
        minRole: 'viewer',
      })
    ).toEqual({ ok: false, status: 404 });
  });

  it('GLOBAL super-admin override: full access without any membership', () => {
    expect(
      decideWorkspaceAccess({
        membershipRole: null,
        superAdmin: true,
        minRole: 'workspace-admin',
      })
    ).toEqual({ ok: true, effectiveRole: 'workspace-admin' });
  });

  it('super-admin override beats an insufficient membership role', () => {
    expect(
      decideWorkspaceAccess({
        membershipRole: 'viewer',
        superAdmin: true,
        minRole: 'workspace-admin',
      })
    ).toEqual({ ok: true, effectiveRole: 'workspace-admin' });
  });
});
