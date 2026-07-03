import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { QuotaLimits } from './constants.js';
import { DeployError } from './errors.js';
import {
  normalizeManifestPath,
  selectMissingUploads,
  validateManifest,
  type ManifestEntry,
} from './manifest.js';

const LIMITS: QuotaLimits = { maxFileBytes: 1_000, maxAppBytes: 5_000 };

function sha(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

const INDEX = { path: 'index.html', sha256: sha('index'), bytes: 100 };
const APP = { path: 'app.js', sha256: sha('app'), bytes: 200 };

describe('normalizeManifestPath', () => {
  it('strips leading ./ and /', () => {
    expect(normalizeManifestPath('./index.html')).toBe('index.html');
    expect(normalizeManifestPath('/assets/app.js')).toBe('assets/app.js');
  });

  it('rejects traversal', () => {
    expect(() => normalizeManifestPath('../secret')).toThrow(DeployError);
    expect(() => normalizeManifestPath('a/../../b')).toThrow(DeployError);
  });
});

describe('validateManifest', () => {
  it('accepts a well-formed manifest with an index.html at root', () => {
    const { entries, totalBytes } = validateManifest([INDEX, APP], LIMITS);
    expect(entries).toHaveLength(2);
    expect(totalBytes).toBe(300);
  });

  it('REJECTS a manifest without a root index.html', () => {
    expect(() => validateManifest([APP], LIMITS)).toThrow(
      expect.objectContaining({ code: 'index_html_required' })
    );
    // a nested index.html does not count
    expect(() =>
      validateManifest([{ path: 'sub/index.html', sha256: sha('x'), bytes: 1 }], LIMITS)
    ).toThrow(expect.objectContaining({ code: 'index_html_required' }));
  });

  it('REJECTS an oversized single file (quota)', () => {
    expect(() =>
      validateManifest([INDEX, { path: 'big.js', sha256: sha('big'), bytes: 1_001 }], LIMITS)
    ).toThrow(expect.objectContaining({ code: 'file_too_large' }));
  });

  it('REJECTS an oversized app total (quota)', () => {
    const files = Array.from({ length: 6 }, (_, i) => ({
      path: i === 0 ? 'index.html' : `f${i}.js`,
      sha256: sha(`f${i}`),
      bytes: 900,
    }));
    expect(() => validateManifest(files, LIMITS)).toThrow(
      expect.objectContaining({ code: 'app_too_large' })
    );
  });

  it('rejects a bad sha256, duplicate path, and empty manifest', () => {
    expect(() =>
      validateManifest([{ path: 'index.html', sha256: 'nope', bytes: 1 }], LIMITS)
    ).toThrow(expect.objectContaining({ code: 'invalid_manifest' }));
    expect(() => validateManifest([], LIMITS)).toThrow(
      expect.objectContaining({ code: 'invalid_manifest' })
    );
    expect(() =>
      validateManifest([INDEX, { path: './index.html', sha256: sha('dup'), bytes: 1 }], LIMITS)
    ).toThrow(expect.objectContaining({ code: 'invalid_manifest' }));
  });
});

describe('selectMissingUploads — dedup', () => {
  const entries: ManifestEntry[] = [INDEX, APP];

  it('returns uploads ONLY for missing hashes (unchanged files omitted)', () => {
    const present = new Set([APP.sha256]); // app.js already stored
    const missing = selectMissingUploads(entries, present);
    expect(missing).toHaveLength(1);
    expect(missing[0].path).toBe('index.html');
  });

  it('returns all when nothing is stored yet', () => {
    expect(selectMissingUploads(entries, new Set())).toHaveLength(2);
  });

  it('emits one representative per unique missing sha256', () => {
    const shared = sha('shared');
    const dup: ManifestEntry[] = [
      INDEX,
      { path: 'a.js', sha256: shared, bytes: 1 },
      { path: 'b.js', sha256: shared, bytes: 1 },
    ];
    const missing = selectMissingUploads(dup, new Set([INDEX.sha256]));
    expect(missing).toHaveLength(1);
    expect(missing[0].sha256).toBe(shared);
  });
});
