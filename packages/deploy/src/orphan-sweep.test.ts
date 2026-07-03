import { describe, expect, it } from 'vitest';
import {
  selectOrphans,
  sweepOrphanBlobs,
  type OrphanSweepDeps,
} from './orphan-sweep.js';

describe('selectOrphans', () => {
  it('returns only the unreferenced hashes', () => {
    expect(selectOrphans(['a', 'b', 'c'], new Set(['a', 'c']))).toEqual(['b']);
    expect(selectOrphans(['a', 'b'], new Set(['a', 'b']))).toEqual([]);
    expect(selectOrphans([], new Set())).toEqual([]);
  });
});

describe('sweepOrphanBlobs', () => {
  it('deletes unreferenced blobs ONLY, never referenced ones', async () => {
    const deleted: string[] = [];
    const deps: OrphanSweepDeps = {
      async listAllShas() {
        return ['keep1', 'orphan1', 'keep2', 'orphan2'];
      },
      async listReferencedShas() {
        return new Set(['keep1', 'keep2']);
      },
      async deleteBlob(sha) {
        deleted.push(sha);
      },
    };

    const result = await sweepOrphanBlobs(deps);
    expect(result.scanned).toBe(4);
    expect(result.deleted.sort()).toEqual(['orphan1', 'orphan2']);
    expect(deleted.sort()).toEqual(['orphan1', 'orphan2']);
    // referenced blobs untouched
    expect(deleted).not.toContain('keep1');
    expect(deleted).not.toContain('keep2');
  });
});
