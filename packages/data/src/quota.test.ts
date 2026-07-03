import { describe, expect, it } from 'vitest';
import { DataError } from './errors.js';
import {
  dataQuotaFromEnv,
  docByteSize,
  enforceWriteQuota,
  DEFAULT_MAX_BYTES_PER_APP,
  DEFAULT_MAX_DOC_BYTES,
  DEFAULT_MAX_DOCS_PER_APP,
  type DataQuotaLimits,
} from './quota.js';

const limits: DataQuotaLimits = {
  maxDocBytes: 100,
  maxDocsPerApp: 3,
  maxBytesPerApp: 250,
};

describe('dataQuotaFromEnv', () => {
  it('uses documented defaults when unset', () => {
    expect(dataQuotaFromEnv({})).toEqual({
      maxDocBytes: DEFAULT_MAX_DOC_BYTES,
      maxDocsPerApp: DEFAULT_MAX_DOCS_PER_APP,
      maxBytesPerApp: DEFAULT_MAX_BYTES_PER_APP,
    });
  });

  it('reads positive integer overrides', () => {
    expect(
      dataQuotaFromEnv({
        DATA_MAX_DOC_BYTES: '5',
        DATA_MAX_DOCS_PER_APP: '2',
        DATA_MAX_BYTES_PER_APP: '9',
      } as NodeJS.ProcessEnv)
    ).toEqual({ maxDocBytes: 5, maxDocsPerApp: 2, maxBytesPerApp: 9 });
  });

  it('ignores non-positive / non-integer overrides', () => {
    expect(
      dataQuotaFromEnv({ DATA_MAX_DOCS_PER_APP: '-1' } as NodeJS.ProcessEnv)
        .maxDocsPerApp
    ).toBe(DEFAULT_MAX_DOCS_PER_APP);
  });
});

describe('docByteSize', () => {
  it('measures UTF-8 JSON bytes', () => {
    expect(docByteSize({ a: 1 })).toBe(Buffer.byteLength('{"a":1}'));
  });
});

describe('enforceWriteQuota', () => {
  const ok = {
    limits,
    newDocBytes: 50,
    liveDocCount: 1,
    liveBytesExcludingTarget: 100,
    isCreate: true,
  };

  it('allows a write within all caps', () => {
    expect(() => enforceWriteQuota(ok)).not.toThrow();
  });

  it('rejects an over-large document', () => {
    try {
      enforceWriteQuota({ ...ok, newDocBytes: 101 });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as DataError).code).toBe('doc_too_large');
    }
  });

  it('rejects a create over the doc-count cap', () => {
    try {
      enforceWriteQuota({ ...ok, liveDocCount: 3 });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as DataError).code).toBe('too_many_docs');
    }
  });

  it('does NOT apply the doc-count cap to an update (isCreate:false)', () => {
    expect(() =>
      enforceWriteQuota({ ...ok, liveDocCount: 99, isCreate: false })
    ).not.toThrow();
  });

  it('rejects a write over the per-app byte cap', () => {
    try {
      enforceWriteQuota({ ...ok, liveBytesExcludingTarget: 220, newDocBytes: 50 });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as DataError).code).toBe('app_too_large');
    }
  });
});
