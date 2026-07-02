import { describe, expect, it } from 'vitest';
import {
  resolveGoogleUser,
  type GoogleUserStore,
} from './ensure-user.server.js';

/** In-memory GoogleUserStore mirroring the users-table uniques (email, sub). */
class FakeUserStore implements GoogleUserStore {
  users: { id: string; email: string; googleSub: string | null }[] = [];
  calls: string[] = [];
  /** Simulate losing the insert race: createUser returns null once. */
  failCreateOnce = false;
  private seq = 0;

  seed(email: string, googleSub: string | null = null): string {
    const id = `u${++this.seq}`;
    this.users.push({ id, email, googleSub });
    return id;
  }

  async findUserBySub(
    sub: string
  ): Promise<{ id: string; email: string } | null> {
    this.calls.push(`findBySub:${sub}`);
    const u = this.users.find((x) => x.googleSub === sub);
    return u ? { id: u.id, email: u.email } : null;
  }

  async findUserIdByEmail(email: string): Promise<string | null> {
    this.calls.push(`findByEmail:${email}`);
    return this.users.find((u) => u.email === email)?.id ?? null;
  }

  async setGoogleSub(userId: string, sub: string): Promise<void> {
    this.calls.push(`link:${userId}:${sub}`);
    const u = this.users.find((x) => x.id === userId);
    if (!u) throw new Error('no such user');
    u.googleSub = sub;
  }

  async createUser(email: string, sub: string): Promise<string | null> {
    this.calls.push(`create:${email}`);
    if (this.failCreateOnce) {
      this.failCreateOnce = false;
      // Simulate the conflict-losing insert AND the winner's row appearing.
      this.seed(email, null);
      return null;
    }
    if (this.users.some((u) => u.email === email)) return null;
    return this.seed(email, sub);
  }
}

const identity = (over: Partial<Parameters<typeof resolveGoogleUser>[1]> = {}) => ({
  sub: 'sub-123',
  email: 'person@example.com',
  emailVerified: true,
  ...over,
});

describe('resolveGoogleUser', () => {
  it('(a) sub match wins — even over an email match', async () => {
    const store = new FakeUserStore();
    const bySubId = store.seed('old-address@example.com', 'sub-123');
    store.seed('person@example.com', null); // same email, different user

    const res = await resolveGoogleUser(store, identity());
    expect(res.userId).toBe(bySubId);
    // The session identity is the users-row email, not the incoming Google
    // email (they can drift when a Google account changes address).
    expect(res.email).toBe('old-address@example.com');
    // Never touched the email-matched user, never linked/created anything.
    expect(store.calls).toEqual(['findBySub:sub-123']);
  });

  it('(b) email match links: sets google_sub on the SAME user, no new row', async () => {
    const store = new FakeUserStore();
    const existing = store.seed('person@example.com', null); // magic-code signup

    const res = await resolveGoogleUser(store, identity());
    expect(res.userId).toBe(existing);
    expect(store.users).toHaveLength(1);
    expect(store.users[0].googleSub).toBe('sub-123');
  });

  it('(b) email is normalized (trim + lowercase) before matching', async () => {
    const store = new FakeUserStore();
    const existing = store.seed('person@example.com', null);

    const res = await resolveGoogleUser(
      store,
      identity({ email: '  Person@Example.COM ' })
    );
    expect(res.userId).toBe(existing);
    expect(res.email).toBe('person@example.com');
    expect(store.users[0].googleSub).toBe('sub-123');
  });

  it('(c) creates a new user with email + google_sub otherwise', async () => {
    const store = new FakeUserStore();
    const res = await resolveGoogleUser(store, identity());
    expect(store.users).toHaveLength(1);
    expect(store.users[0]).toMatchObject({
      id: res.userId,
      email: 'person@example.com',
      googleSub: 'sub-123',
    });
  });

  it('(c) lost insert race falls back to re-read + link (still one user)', async () => {
    const store = new FakeUserStore();
    store.failCreateOnce = true;

    const res = await resolveGoogleUser(store, identity());
    expect(store.users).toHaveLength(1);
    expect(store.users[0].id).toBe(res.userId);
    expect(store.users[0].googleSub).toBe('sub-123');
  });

  it('rejects email_verified=false — no lookup, no link, no create', async () => {
    const store = new FakeUserStore();
    store.seed('person@example.com', null);

    await expect(
      resolveGoogleUser(store, identity({ emailVerified: false }))
    ).rejects.toThrow(/not verified/);
    expect(store.calls).toEqual([]);
    expect(store.users[0].googleSub).toBeNull();
  });

  it('rejects an identity missing sub or email', async () => {
    const store = new FakeUserStore();
    await expect(
      resolveGoogleUser(store, identity({ sub: '' }))
    ).rejects.toThrow(/missing sub\/email/);
    await expect(
      resolveGoogleUser(store, identity({ email: '' }))
    ).rejects.toThrow(/missing sub\/email/);
    expect(store.users).toHaveLength(0);
  });
});
