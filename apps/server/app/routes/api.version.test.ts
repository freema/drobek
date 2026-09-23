import { afterEach, describe, expect, it } from 'vitest';
import { loader } from './api.version';

const originalGitSha = process.env.GIT_SHA;
const originalVersion = process.env.DROBEK_VERSION;

function restore(name: 'GIT_SHA' | 'DROBEK_VERSION', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore('GIT_SHA', originalGitSha);
  restore('DROBEK_VERSION', originalVersion);
});

describe('/api/version loader', () => {
  it('returns the GIT_SHA env as sha and DROBEK_VERSION as version', async () => {
    process.env.GIT_SHA = 'abc1234';
    process.env.DROBEK_VERSION = 'v1.2.3';
    const res = loader();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ sha: 'abc1234', version: 'v1.2.3' });
  });

  it('falls back to "dev" when GIT_SHA / DROBEK_VERSION are unset', async () => {
    delete process.env.GIT_SHA;
    delete process.env.DROBEK_VERSION;
    const res = loader();
    expect(await res.json()).toEqual({ sha: 'dev', version: 'dev' });
  });
});
