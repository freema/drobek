import { describe, expect, it } from 'vitest';
import { chooseRollbackTarget, type RollbackCandidate } from './rollback-target.js';

const v1: RollbackCandidate = { id: 'v1', state: 'ready', createdAt: 1000, activatedAt: 1000 };
const v2: RollbackCandidate = { id: 'v2', state: 'ready', createdAt: 2000, activatedAt: 2000 };

describe('chooseRollbackTarget', () => {
  it('repoints to the previous ready deploy when active is the latest', () => {
    const choice = chooseRollbackTarget([v1, v2], 'v2');
    expect(choice).toEqual({ ok: true, deployId: 'v1' });
  });

  it('honors an explicit toDeployId when it is a ready deploy', () => {
    expect(chooseRollbackTarget([v1, v2], 'v2', 'v1')).toEqual({ ok: true, deployId: 'v1' });
  });

  it('rejects an explicit target that is not a ready deploy of the app', () => {
    const failed: RollbackCandidate = { id: 'v3', state: 'failed', createdAt: 3000, activatedAt: null };
    expect(chooseRollbackTarget([v1, v2, failed], 'v2', 'v3')).toEqual({ ok: false });
    expect(chooseRollbackTarget([v1, v2], 'v2', 'nope')).toEqual({ ok: false });
  });

  it('ignores non-ready deploys when picking the previous version', () => {
    const queued: RollbackCandidate = { id: 'vq', state: 'queued', createdAt: 3000, activatedAt: null };
    expect(chooseRollbackTarget([v1, v2, queued], 'v2')).toEqual({ ok: true, deployId: 'v1' });
  });

  it('fails when there is no other ready deploy to roll back to', () => {
    expect(chooseRollbackTarget([v2], 'v2')).toEqual({ ok: false });
    expect(chooseRollbackTarget([], null)).toEqual({ ok: false });
  });
});
