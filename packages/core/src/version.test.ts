import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { CORE_VERSION, coreVersion } from './version.js';

const originalGitSha = process.env.GIT_SHA;

afterEach(() => {
  if (originalGitSha === undefined) {
    delete process.env.GIT_SHA;
  } else {
    process.env.GIT_SHA = originalGitSha;
  }
});

describe('coreVersion', () => {
  it('stays in sync with package.json version', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as { version: string };
    expect(CORE_VERSION).toBe(pkg.version);
  });

  it('returns name, version and the GIT_SHA env', () => {
    process.env.GIT_SHA = 'abc1234';
    expect(coreVersion()).toEqual({
      name: '@drobek/core',
      version: CORE_VERSION,
      sha: 'abc1234',
    });
  });

  it('falls back to "dev" without GIT_SHA', () => {
    delete process.env.GIT_SHA;
    expect(coreVersion().sha).toBe('dev');
  });
});
