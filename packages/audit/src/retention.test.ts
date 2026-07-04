import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUDIT_RETENTION_DAYS,
  auditRetentionDays,
  retentionCutoff,
} from './retention.server.js';
import { encodeCursor } from './read.server.js';

describe('auditRetentionDays (env config)', () => {
  it('defaults to a generous window when unset/blank', () => {
    expect(auditRetentionDays({})).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
    expect(auditRetentionDays({ AUDIT_RETENTION_DAYS: '   ' })).toBe(
      DEFAULT_AUDIT_RETENTION_DAYS
    );
  });

  it('reads a positive integer override', () => {
    expect(auditRetentionDays({ AUDIT_RETENTION_DAYS: '30' })).toBe(30);
  });

  it('rejects non-positive / non-numeric values → default', () => {
    expect(auditRetentionDays({ AUDIT_RETENTION_DAYS: '0' })).toBe(
      DEFAULT_AUDIT_RETENTION_DAYS
    );
    expect(auditRetentionDays({ AUDIT_RETENTION_DAYS: '-5' })).toBe(
      DEFAULT_AUDIT_RETENTION_DAYS
    );
    expect(auditRetentionDays({ AUDIT_RETENTION_DAYS: 'abc' })).toBe(
      DEFAULT_AUDIT_RETENTION_DAYS
    );
  });
});

describe('retentionCutoff (age-based only)', () => {
  it('subtracts exactly retentionDays from now', () => {
    const now = new Date('2026-07-04T00:00:00.000Z');
    const cutoff = retentionCutoff(10, now);
    expect(cutoff.toISOString()).toBe('2026-06-24T00:00:00.000Z');
  });

  it('is a pure function of (days, now) — no row identity involved', () => {
    const now = new Date('2026-07-04T12:00:00.000Z');
    expect(retentionCutoff(365, now).getTime()).toBe(
      now.getTime() - 365 * 86_400_000
    );
  });
});

describe('encodeCursor (keyset pagination)', () => {
  it('is url-safe base64 that round-trips the (createdAt,id) keyset', () => {
    const createdAt = new Date('2026-07-04T09:08:07.006Z');
    const cursor = encodeCursor({ createdAt, id: 'audit_abc123' });
    expect(cursor).not.toMatch(/[+/=]/);
    const decoded = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8')
    );
    expect(decoded).toEqual({ t: createdAt.toISOString(), i: 'audit_abc123' });
  });
});
