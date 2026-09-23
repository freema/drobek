import { afterEach, describe, expect, it } from 'vitest';
import { loader } from './api.version';

const originalGitSha = process.env.GIT_SHA;

afterEach(() => {
  if (originalGitSha === undefined) {
    delete process.env.GIT_SHA;
  } else {
    process.env.GIT_SHA = originalGitSha;
  }
});

describe('/api/version loader', () => {
  it('returns the GIT_SHA env as sha', async () => {
    process.env.GIT_SHA = 'abc1234';
    const res = loader();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ sha: 'abc1234' });
  });

  it('falls back to "dev" when GIT_SHA is unset', async () => {
    delete process.env.GIT_SHA;
    const res = loader();
    expect(await res.json()).toEqual({ sha: 'dev' });
  });
});
