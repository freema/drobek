import { describe, expect, it } from 'vitest';
import { DataError } from './errors.js';
import {
  DEFAULT_MAX_BYTES_PER_APP,
  DEFAULT_MAX_DOC_BYTES,
  DEFAULT_MAX_DOCS_PER_APP,
  dataQuotaFromLimits,
  docByteSize,
  enforceWriteQuota,
  type DataQuotaLimits,
} from './quota.js';

const limits: DataQuotaLimits = { maxDocBytes: 100, maxDocsPerApp: 3, maxBytesPerApp: 250 };

function thrown(fn: () => void): DataError {
  try {
    fn();
  } catch (err) {
    return err as DataError;
  }
  throw new Error('should have thrown');
}

describe('dataQuotaFromLimits', () => {
  it('uses the documented defaults when unset', () => {
    expect(dataQuotaFromLimits({})).toEqual({
      maxDocBytes: DEFAULT_MAX_DOC_BYTES,
      maxDocsPerApp: DEFAULT_MAX_DOCS_PER_APP,
      maxBytesPerApp: DEFAULT_MAX_BYTES_PER_APP,
    });
  });

  it('reads positive integer limits', () => {
    expect(dataQuotaFromLimits({ DATA_MAX_DOC_BYTES: 5, DATA_MAX_DOCS_PER_APP: 2, DATA_MAX_BYTES_PER_APP: 9 })).toEqual({
      maxDocBytes: 5,
      maxDocsPerApp: 2,
      maxBytesPerApp: 9,
    });
  });

  it('ignores non-positive / non-integer values', () => {
    expect(dataQuotaFromLimits({ DATA_MAX_DOCS_PER_APP: -1 }).maxDocsPerApp).toBe(DEFAULT_MAX_DOCS_PER_APP);
    expect(dataQuotaFromLimits({ DATA_MAX_DOC_BYTES: 1.5 }).maxDocBytes).toBe(DEFAULT_MAX_DOC_BYTES);
  });
});

describe('docByteSize', () => {
  it('measures UTF-8 JSON bytes', () => {
    expect(docByteSize({ a: 1 })).toBe(Buffer.byteLength('{"a":1}'));
    expect(docByteSize({ a: 'ř' })).toBe(Buffer.byteLength('{"a":"ř"}'));
  });
});

describe('enforceWriteQuota', () => {
  const ok = { limits, newDocBytes: 50, liveDocCount: 1, liveBytesExcludingTarget: 100, isCreate: true };

  it('allows a write within all caps', () => {
    expect(() => enforceWriteQuota(ok)).not.toThrow();
  });

  it('rejects an over-large record (413 payload_too_large)', () => {
    const err = thrown(() => enforceWriteQuota({ ...ok, newDocBytes: 101 }));
    expect(err.code).toBe('payload_too_large');
    expect(err.status).toBe(413);
    expect(err.details).toEqual({ limit: 'DATA_MAX_DOC_BYTES', value: 100 });
  });

  it('rejects a create over the record cap (409 quota_exceeded)', () => {
    const err = thrown(() => enforceWriteQuota({ ...ok, liveDocCount: 3 }));
    expect(err.code).toBe('quota_exceeded');
    expect(err.status).toBe(409);
    expect(err.details).toEqual({ limit: 'DATA_MAX_DOCS_PER_APP', value: 3 });
  });

  it('does NOT apply the record cap to an update (isCreate:false)', () => {
    expect(() => enforceWriteQuota({ ...ok, liveDocCount: 99, isCreate: false })).not.toThrow();
  });

  it('rejects a write over the per-app byte cap', () => {
    const err = thrown(() => enforceWriteQuota({ ...ok, liveBytesExcludingTarget: 220, newDocBytes: 50 }));
    expect(err.code).toBe('quota_exceeded');
    expect(err.details).toEqual({ limit: 'DATA_MAX_BYTES_PER_APP', value: 250 });
  });
});
