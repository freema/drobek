/**
 * The lease value in Redis stays readable by the previous release (v0.10.5),
 * so a rollback keeps every lease: it requires `holder_user_id` and
 * `expires_at` and reads `session_id`. And the current parser reads a lease
 * that release wrote, which has no `grant`.
 */
import { describe, expect, it } from 'vitest';
import { parseLease } from '@drobek/apps';
import { memoryLeaseStore, redisLeaseStore } from './lease.js';

/** `parseLease` as v0.10.5 shipped it (packages/apps/src/lease.server.ts at adc61f1). */
function parseLeaseV0105(raw: string | null | undefined): { holder_user_id: string; session_id: string; expires_at: string; renewed_at?: string } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { holder_user_id?: unknown; session_id?: unknown; expires_at?: unknown; renewed_at?: unknown };
    if (typeof v.holder_user_id !== 'string' || typeof v.expires_at !== 'string') return null;
    const lease: { holder_user_id: string; session_id: string; expires_at: string; renewed_at?: string } = {
      holder_user_id: v.holder_user_id,
      session_id: String(v.session_id ?? ''),
      expires_at: v.expires_at,
    };
    if (typeof v.renewed_at === 'string') lease.renewed_at = v.renewed_at;
    return lease;
  } catch {
    return null;
  }
}

const NOW = Date.parse('2026-10-27T12:00:00.000Z');

describe('the lease value across releases', () => {
  it('a lease the Redis store writes passes the v0.10.5 parser, with the grant as its session_id', async () => {
    const written: string[] = [];
    const redis = {
      eval: async (_script: string, _keys: number, _key: string, _user: string, value: string) => {
        written.push(value);
        return [1, value];
      },
      mget: async () => [],
      get: async () => null,
    };
    const store = redisLeaseStore(() => redis as never, () => NOW);
    const res = await store.acquire('app-1', { userId: 'user-1', grant: 'api_key:key-1' }, 180_000);
    expect(res).toMatchObject({ acquired: true, lease: { holder_user_id: 'user-1', grant: 'api_key:key-1', session_id: 'api_key:key-1' } });

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0])).toEqual({
      holder_user_id: 'user-1',
      session_id: 'api_key:key-1',
      grant: 'api_key:key-1',
      expires_at: '2026-10-27T12:03:00.000Z',
      renewed_at: '2026-10-27T12:00:00.000Z',
    });
    expect(parseLeaseV0105(written[0])).toEqual({
      holder_user_id: 'user-1',
      session_id: 'api_key:key-1',
      expires_at: '2026-10-27T12:03:00.000Z',
      renewed_at: '2026-10-27T12:00:00.000Z',
    });
  });

  it('a lease v0.10.5 wrote (session_id, no grant) parses with its session_id as the grant', () => {
    const old = JSON.stringify({ holder_user_id: 'user-1', session_id: '6f1c2a9e-session', expires_at: '2026-10-27T12:03:00.000Z' });
    expect(parseLease(old)).toEqual({
      holder_user_id: 'user-1',
      session_id: '6f1c2a9e-session',
      grant: '6f1c2a9e-session',
      expires_at: '2026-10-27T12:03:00.000Z',
    });
  });

  it('the memory store keeps the same shape', async () => {
    const store = memoryLeaseStore(() => NOW);
    const res = await store.acquire('app-1', { userId: 'user-1', grant: 'oauth:client-1' }, 180_000);
    expect(res.lease).toMatchObject({ session_id: 'oauth:client-1', grant: 'oauth:client-1' });
    expect(parseLeaseV0105(JSON.stringify(res.lease))).toMatchObject({ holder_user_id: 'user-1', session_id: 'oauth:client-1' });
  });
});
