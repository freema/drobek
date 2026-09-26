import { describe, expect, it, vi } from 'vitest';

const runHealthChecks = vi.fn();
vi.mock('@drobek/core', () => ({
  runHealthChecks: (...args: unknown[]) => runHealthChecks(...args),
}));
const MODULES = [
  { name: 'auth', version: '1.0.0', source: 'builtin', contract: '^1.1' },
  { name: 'guestbook', version: '1.0.0', source: 'dir', contract: '^1.1' },
];
vi.mock('@drobek/modules', () => ({ activeModules: async () => MODULES }));

import { loader } from './healthz';

describe('/healthz loader', () => {
  it('returns 200 with the health body and the active modules when everything is up', async () => {
    runHealthChecks.mockResolvedValueOnce({ ok: true, db: 'up', redis: 'up' });
    const res = await loader();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true, db: 'up', redis: 'up', modules: MODULES });
  });

  it('returns 503 when a dependency is down', async () => {
    runHealthChecks.mockResolvedValueOnce({
      ok: false,
      db: 'up',
      redis: 'down',
    });
    const res = await loader();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, db: 'up', redis: 'down', modules: MODULES });
  });
});
