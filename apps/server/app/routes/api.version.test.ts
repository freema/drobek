import { afterEach, describe, expect, it } from 'vitest';
import { setModuleRuntimeForTests, type ModuleRuntime } from '@drobek/modules';
import { loader } from './api.version';

const originalGitSha = process.env.GIT_SHA;
const originalVersion = process.env.DROBEK_VERSION;

function restore(name: 'GIT_SHA' | 'DROBEK_VERSION', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const MODULES = [{ name: 'guestbook', version: '1.0.0', source: 'dir', contract: '^1.1' }];

afterEach(() => {
  restore('GIT_SHA', originalGitSha);
  restore('DROBEK_VERSION', originalVersion);
  setModuleRuntimeForTests(null);
});

describe('/api/version loader', () => {
  it('returns the GIT_SHA env as sha, DROBEK_VERSION as version and the active modules', async () => {
    process.env.GIT_SHA = 'abc1234';
    process.env.DROBEK_VERSION = 'v1.2.3';
    setModuleRuntimeForTests({ summary: () => MODULES } as unknown as ModuleRuntime);
    const res = await loader();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ sha: 'abc1234', version: 'v1.2.3', modules: MODULES });
  });

  it('falls back to "dev" when GIT_SHA / DROBEK_VERSION are unset', async () => {
    delete process.env.GIT_SHA;
    delete process.env.DROBEK_VERSION;
    setModuleRuntimeForTests({ summary: () => [] } as unknown as ModuleRuntime);
    const res = await loader();
    expect(await res.json()).toEqual({ sha: 'dev', version: 'dev', modules: [] });
  });
});
