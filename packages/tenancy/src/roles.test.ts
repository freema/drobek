import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_ROLES,
  decideWorkspaceAccess,
  describeWorkspaceAccess,
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

describe('describeWorkspaceAccess — the source of access the dashboard shows', () => {
  it('a super-admin without a membership is labelled as superadmin access, not as a member role', () => {
    const d = describeWorkspaceAccess({ membershipRole: null, superAdmin: true });
    expect(d?.source).toBe('superadmin');
    expect(d?.memberRole).toBeNull();
    expect(d?.label).toBe('Superadmin access — not a member');
    // the authorization decision is unchanged: still full access
    expect(decideWorkspaceAccess({ membershipRole: null, superAdmin: true, minRole: 'workspace-admin' })).toEqual({
      ok: true,
      effectiveRole: 'workspace-admin',
    });
  });

  it('a real workspace admin shows its membership role', () => {
    const d = describeWorkspaceAccess({ membershipRole: 'workspace-admin', superAdmin: false });
    expect(d).toMatchObject({ source: 'member', memberRole: 'workspace-admin', label: 'workspace-admin' });
  });

  it('a plain member shows its membership role', () => {
    expect(describeWorkspaceAccess({ membershipRole: 'viewer', superAdmin: false })?.label).toBe('viewer');
    expect(describeWorkspaceAccess({ membershipRole: 'editor', superAdmin: false })?.label).toBe('editor');
  });

  it('a super-admin who is also a member keeps the member role and names the override when it grants more', () => {
    expect(describeWorkspaceAccess({ membershipRole: 'workspace-admin', superAdmin: true })?.label).toBe(
      'workspace-admin'
    );
    const d = describeWorkspaceAccess({ membershipRole: 'viewer', superAdmin: true });
    expect(d).toMatchObject({ source: 'member', memberRole: 'viewer', label: 'viewer · superadmin access' });
  });

  it('no membership and no super-admin means no access to describe', () => {
    expect(describeWorkspaceAccess({ membershipRole: null, superAdmin: false })).toBeNull();
  });
});
