/**
 * The browser half of the auth module: bundled into `/__drobek/sdk.js` as
 * `drobek.auth` by the drobek server at start. Runs in the app's page; holds
 * no token (the session is an HttpOnly cookie on the app host). Keeps the
 * last known user so `onChange` listeners (e.g. `<LoginGate>`) stay in sync
 * across `me` / `verify` / `logout`.
 */
import type { SdkCore } from '@drobek/sdk';

export interface User {
  id: string;
  email: string;
  role: 'user' | 'admin';
}

export interface SentCode {
  sent: true;
  email: string;
  /** Seconds the code stays valid. */
  expires_in: number;
}

export interface AuthApi {
  me(): Promise<User | null>;
  sendCode(email: string): Promise<SentCode>;
  verify(email: string, code: string): Promise<User>;
  logout(): Promise<void>;
  onChange(listener: (user: User | null) => void): () => void;
}

function sameUser(a: User | null | undefined, b: User | null): boolean {
  if (a === undefined) return false;
  if (a === null || b === null) return a === b;
  return a.id === b.id && a.email === b.email && a.role === b.role;
}

export default function auth(core: SdkCore): AuthApi {
  let current: User | null | undefined;
  const listeners = new Set<(user: User | null) => void>();

  const set = (user: User | null): void => {
    const changed = !sameUser(current, user);
    current = user;
    if (!changed) return;
    for (const listener of [...listeners]) {
      try {
        listener(user);
      } catch {
        /* a listener's error never breaks the SDK */
      }
    }
  };

  return {
    async me() {
      const r = await core.request<{ user: User | null }>('GET', '/me');
      set(r.user);
      return r.user;
    },
    sendCode(email) {
      return core.request<SentCode>('POST', '/send-code', { body: { email } });
    },
    async verify(email, code) {
      const r = await core.request<{ user: User }>('POST', '/verify', { body: { email, code } });
      set(r.user);
      return r.user;
    },
    async logout() {
      await core.request('POST', '/logout');
      set(null);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
