import { afterEach, describe, expect, it } from 'vitest';
import { credentialsRevoked, onCredentialsRevoked } from './revocations.js';

const unsubscribes: Array<() => void> = [];

afterEach(() => {
  for (const off of unsubscribes.splice(0)) off();
});

describe('the revocation signal', () => {
  it("reaches every listener with the user's id until it unsubscribes", () => {
    const a: string[] = [];
    const b: string[] = [];
    const offA = onCredentialsRevoked((userId) => void a.push(userId));
    unsubscribes.push(offA, onCredentialsRevoked((userId) => void b.push(userId)));

    credentialsRevoked('u1');
    offA();
    credentialsRevoked('u2');

    expect(a).toEqual(['u1']);
    expect(b).toEqual(['u1', 'u2']);
  });

  it('a throwing listener neither fails the revocation nor stops the others', () => {
    const seen: string[] = [];
    unsubscribes.push(
      onCredentialsRevoked(() => {
        throw new Error('listener failed');
      }),
      onCredentialsRevoked((userId) => void seen.push(userId))
    );
    expect(() => credentialsRevoked('u3')).not.toThrow();
    expect(seen).toEqual(['u3']);
  });

  it('is shared through globalThis, so a second copy of the package reaches the same listeners', () => {
    const key = Symbol.for('drobek.oauth.revocationListeners');
    const seen: string[] = [];
    unsubscribes.push(onCredentialsRevoked((userId) => void seen.push(userId)));
    const shared = (globalThis as Record<symbol, Set<(userId: string) => void> | undefined>)[key];
    for (const listener of shared ?? []) listener('u4');
    expect(seen).toEqual(['u4']);
  });
});
