import { describe, expect, it } from 'vitest';
import { runHealthChecks } from './health.js';

const up = async (): Promise<void> => {};
const down = async (): Promise<void> => {
  throw new Error('dependency down');
};

describe('runHealthChecks', () => {
  it('reports ok when both pings succeed', async () => {
    const body = await runHealthChecks({ dbPing: up, redisPing: up });
    expect(body).toEqual({ ok: true, db: 'up', redis: 'up' });
  });

  it('reports redis down and ok=false when redis ping fails', async () => {
    const body = await runHealthChecks({ dbPing: up, redisPing: down });
    expect(body).toEqual({ ok: false, db: 'up', redis: 'down' });
  });

  it('reports db down and ok=false when db ping fails', async () => {
    const body = await runHealthChecks({ dbPing: down, redisPing: up });
    expect(body).toEqual({ ok: false, db: 'down', redis: 'up' });
  });

  it('reports both down when everything fails', async () => {
    const body = await runHealthChecks({ dbPing: down, redisPing: down });
    expect(body).toEqual({ ok: false, db: 'down', redis: 'down' });
  });
});
