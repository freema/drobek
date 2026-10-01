import { afterEach, describe, expect, it } from 'vitest';
import { setModuleRuntimeForTests, type ModuleRuntime } from '@drobek/modules';
import { loader } from './api.version';

type EnvName = 'GIT_SHA' | 'DROBEK_VERSION' | 'GIT_COMMIT_TIME';
const ENV_NAMES: EnvName[] = ['GIT_SHA', 'DROBEK_VERSION', 'GIT_COMMIT_TIME'];
const original = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));

const MODULES = [
  { name: 'guestbook', version: '1.0.0', source: 'dir', contract: '^1.1' },
  { name: 'sentinel', version: '1.0.0', source: 'dir', contract: '^1.2', operatorOnly: true },
];

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = original.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  setModuleRuntimeForTests(null);
});

describe('/api/version loader', () => {
  it('returns the name, sha, version, the commit time in UTC, the process start and the active modules (an operator-only one marked)', async () => {
    process.env.GIT_SHA = 'abc1234';
    process.env.DROBEK_VERSION = 'v1.2.3';
    process.env.GIT_COMMIT_TIME = '2026-09-27T14:05:09+02:00';
    setModuleRuntimeForTests({ summary: () => MODULES } as unknown as ModuleRuntime);
    const res = await loader();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { startedAt: string };
    expect(body).toEqual({
      name: 'drobek',
      sha: 'abc1234',
      version: 'v1.2.3',
      commitTime: '2026-09-27T12:05:09.000Z',
      startedAt: expect.any(String),
      modules: MODULES,
    });
    const startedAt = new Date(body.startedAt);
    expect(startedAt.toISOString()).toBe(body.startedAt);
    expect(startedAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(startedAt.getTime()).toBeGreaterThan(Date.now() - (process.uptime() + 5) * 1000);
  });

  it('keeps startedAt stable across requests', async () => {
    setModuleRuntimeForTests({ summary: () => [] } as unknown as ModuleRuntime);
    const first = (await (await loader()).json()) as { startedAt: string };
    const second = (await (await loader()).json()) as { startedAt: string };
    expect(second.startedAt).toBe(first.startedAt);
  });

  it('falls back to "dev" and a null commitTime when the build values are unset or unreadable', async () => {
    delete process.env.GIT_SHA;
    delete process.env.DROBEK_VERSION;
    delete process.env.GIT_COMMIT_TIME;
    setModuleRuntimeForTests({ summary: () => [] } as unknown as ModuleRuntime);
    expect(await (await loader()).json()).toMatchObject({ name: 'drobek', sha: 'dev', version: 'dev', commitTime: null, modules: [] });
    process.env.GIT_COMMIT_TIME = 'yesterday';
    expect(await (await loader()).json()).toMatchObject({ commitTime: null });
  });
});
