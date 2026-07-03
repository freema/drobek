import { describe, expect, it } from 'vitest';
import {
  ANON_CALLER,
  decideDataAccess,
  decideMemberDataAccess,
  isAccessMode,
  type AccessMode,
  type DataCaller,
  type DataOperation,
} from './access.js';

const member = (role: 'viewer' | 'editor' | 'workspace-admin'): DataCaller => ({
  authenticated: true,
  role,
});

function status(
  accessMode: AccessMode,
  operation: DataOperation,
  caller: DataCaller
): 'ok' | 401 | 403 {
  const d = decideDataAccess({ accessMode, operation, caller });
  return d.ok ? 'ok' : d.status;
}

describe('decideDataAccess matrix', () => {
  it('public-read: anon reads, anon writes 401, editor writes', () => {
    expect(status('public-read', 'read', ANON_CALLER)).toBe('ok');
    expect(status('public-read', 'write', ANON_CALLER)).toBe(401);
    expect(status('public-read', 'read', member('viewer'))).toBe('ok');
    expect(status('public-read', 'write', member('viewer'))).toBe(403);
    expect(status('public-read', 'write', member('editor'))).toBe('ok');
  });

  it('public-write: anon reads AND writes', () => {
    expect(status('public-write', 'read', ANON_CALLER)).toBe('ok');
    expect(status('public-write', 'write', ANON_CALLER)).toBe('ok');
    expect(status('public-write', 'write', member('viewer'))).toBe('ok');
  });

  it('locked: anon rejected 401 both ops; viewer reads; editor writes', () => {
    expect(status('locked', 'read', ANON_CALLER)).toBe(401);
    expect(status('locked', 'write', ANON_CALLER)).toBe(401);
    expect(status('locked', 'read', member('viewer'))).toBe('ok');
    expect(status('locked', 'write', member('viewer'))).toBe(403);
    expect(status('locked', 'write', member('editor'))).toBe('ok');
    expect(status('locked', 'write', member('workspace-admin'))).toBe('ok');
  });

  it('an authenticated caller with no role is treated as unauthorized member (403)', () => {
    const ghost: DataCaller = { authenticated: true, role: null };
    expect(status('locked', 'read', ghost)).toBe(403);
  });
});

describe('decideMemberDataAccess (dashboard member-view gate)', () => {
  it('viewer can READ any collection but CANNOT delete/write', () => {
    expect(decideMemberDataAccess({ role: 'viewer', operation: 'read' })).toBe(
      true
    );
    expect(decideMemberDataAccess({ role: 'viewer', operation: 'write' })).toBe(
      false
    );
  });

  it('editor + workspace-admin can read AND write/delete', () => {
    for (const role of ['editor', 'workspace-admin'] as const) {
      expect(decideMemberDataAccess({ role, operation: 'read' })).toBe(true);
      expect(decideMemberDataAccess({ role, operation: 'write' })).toBe(true);
    }
  });

  it('a non-member (null role) is denied for both read and write', () => {
    expect(decideMemberDataAccess({ role: null, operation: 'read' })).toBe(false);
    expect(decideMemberDataAccess({ role: null, operation: 'write' })).toBe(
      false
    );
  });
});

describe('isAccessMode', () => {
  it('accepts the four modes and rejects others', () => {
    for (const m of ['public-read', 'public-write', 'locked', 'owner-only']) {
      expect(isAccessMode(m)).toBe(true);
    }
    expect(isAccessMode('private')).toBe(false);
    expect(isAccessMode(42)).toBe(false);
  });
});
