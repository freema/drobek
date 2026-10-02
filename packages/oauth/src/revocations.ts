/**
 * The in-process signal that a credential of a user was revoked: an API key,
 * an OAuth connection, or a refresh-token lineage. The MCP endpoint listens
 * and closes that user's sessions whose credential is no longer live.
 *
 * The listeners live on globalThis, so a revocation made by the dashboard's
 * bundled copy of this package reaches the endpoint the server mounted.
 */
const KEY = Symbol.for('drobek.oauth.revocationListeners');

type Listener = (userId: string) => void;
type Holder = { [KEY]?: Set<Listener> };

function listeners(): Set<Listener> {
  const g = globalThis as Holder;
  g[KEY] ??= new Set();
  return g[KEY];
}

/** Call `listener` with the user's id after each revocation in this process; returns the unsubscribe. */
export function onCredentialsRevoked(listener: Listener): () => void {
  const set = listeners();
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/** Tell the listeners that a credential of `userId` was revoked. A failing listener never fails the revocation. */
export function credentialsRevoked(userId: string): void {
  for (const listener of [...listeners()]) {
    try {
      listener(userId);
    } catch {
      // A listener reports its own failures; the revocation itself is done.
    }
  }
}
