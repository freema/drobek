import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenancyFakeRedis } from './fake-redis.js';

let fake: TenancyFakeRedis;

vi.mock('@drobek/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@drobek/core')>();
  return {
    ...actual,
    getRedis: () => fake as unknown as ReturnType<typeof actual.getRedis>,
  };
});

import {
  INVITE_TTL_SEC,
  acceptInviteUrl,
  consumeInvite,
  createInvite,
  getInvite,
  resolveAcceptedRole,
} from './invites.server.js';

beforeEach(() => {
  fake = new TenancyFakeRedis();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('createInvite', () => {
  it('stores JSON under drobek:invite:<64-hex token> with a 7-day TTL', async () => {
    const { token } = await createInvite({
      workspaceId: 'ws1',
      role: 'editor',
      invitedByUserId: 'u1',
      email: 'teammate@example.com',
    });

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const key = `drobek:invite:${token}`;
    expect(await fake.exists(key)).toBe(1);

    const ttl = await fake.ttl(key);
    expect(ttl).toBeGreaterThan(INVITE_TTL_SEC - 60);
    expect(ttl).toBeLessThanOrEqual(INVITE_TTL_SEC);

    const record = JSON.parse((await fake.get(key)) as string);
    expect(record).toMatchObject({
      workspaceId: 'ws1',
      role: 'editor',
      email: 'teammate@example.com',
      invitedBy: 'u1',
    });
    expect(typeof record.createdAt).toBe('string');
  });

  it('link-only invites store email: null', async () => {
    const { token } = await createInvite({
      workspaceId: 'ws1',
      role: 'viewer',
      invitedByUserId: 'u1',
    });
    const record = JSON.parse(
      (await fake.get(`drobek:invite:${token}`)) as string
    );
    expect(record.email).toBeNull();
  });

  it('rejects roles outside the fixed union', async () => {
    await expect(
      createInvite({
        workspaceId: 'ws1',
        role: 'super-admin' as never,
        invitedByUserId: 'u1',
      })
    ).rejects.toThrow('invalid invite role');
  });
});

describe('getInvite (peek) + consumeInvite (single-use)', () => {
  it('peek returns the record WITHOUT consuming it', async () => {
    const { token } = await createInvite({
      workspaceId: 'ws1',
      role: 'editor',
      invitedByUserId: 'u1',
    });
    expect(await getInvite(token)).toMatchObject({ workspaceId: 'ws1' });
    expect(await getInvite(token)).toMatchObject({ workspaceId: 'ws1' });
    expect(await fake.exists(`drobek:invite:${token}`)).toBe(1);
  });

  it('consume returns the record exactly ONCE (GETDEL)', async () => {
    const { token } = await createInvite({
      workspaceId: 'ws1',
      role: 'editor',
      invitedByUserId: 'u1',
    });
    expect(await consumeInvite(token)).toMatchObject({
      workspaceId: 'ws1',
      role: 'editor',
    });
    expect(await consumeInvite(token)).toBeNull();
    expect(await getInvite(token)).toBeNull();
  });

  it('wrong/garbage tokens return null and never build a redis key', async () => {
    expect(await getInvite('deadbeef')).toBeNull(); // too short
    expect(await getInvite('Z'.repeat(64))).toBeNull(); // non-hex
    expect(await getInvite(`${'a'.repeat(63)}*`)).toBeNull();
    expect(await consumeInvite('drobek:session:sneaky')).toBeNull();
    expect(fake.store.size).toBe(0);

    // A well-formed but unknown token is simply gone/expired.
    expect(await consumeInvite('a'.repeat(64))).toBeNull();
  });

  it('an expired invite is gone', async () => {
    vi.useFakeTimers();
    const { token } = await createInvite({
      workspaceId: 'ws1',
      role: 'viewer',
      invitedByUserId: 'u1',
    });
    vi.advanceTimersByTime((INVITE_TTL_SEC + 1) * 1000);
    expect(await getInvite(token)).toBeNull();
    expect(await consumeInvite(token)).toBeNull();
  });

  it('corrupted payloads are treated as invalid, not thrown', async () => {
    const token = 'b'.repeat(64);
    await fake.set(`drobek:invite:${token}`, 'not-json');
    expect(await getInvite(token)).toBeNull();
    await fake.set(`drobek:invite:${token}`, JSON.stringify({ role: 'nope' }));
    expect(await consumeInvite(token)).toBeNull();
  });
});

describe('resolveAcceptedRole (accept keeps the HIGHER role)', () => {
  it('no existing membership → the invited role', () => {
    expect(resolveAcceptedRole(null, 'editor')).toBe('editor');
    expect(resolveAcceptedRole(null, 'viewer')).toBe('viewer');
  });

  it('upgrade: viewer invited as editor becomes editor', () => {
    expect(resolveAcceptedRole('viewer', 'editor')).toBe('editor');
    expect(resolveAcceptedRole('editor', 'workspace-admin')).toBe(
      'workspace-admin'
    );
  });

  it('never downgrades: workspace-admin invited as viewer stays admin', () => {
    expect(resolveAcceptedRole('workspace-admin', 'viewer')).toBe(
      'workspace-admin'
    );
    expect(resolveAcceptedRole('editor', 'viewer')).toBe('editor');
  });
});

describe('acceptInviteUrl', () => {
  it('builds PUBLIC_ORIGIN + /invite/<token>, trailing slashes stripped', () => {
    const token = 'c'.repeat(64);
    expect(acceptInviteUrl(token, { PUBLIC_ORIGIN: 'https://drobek.app/' })).toBe(
      `https://drobek.app/invite/${token}`
    );
    expect(acceptInviteUrl(token, {})).toBe(
      `http://localhost:3041/invite/${token}`
    );
  });
});
