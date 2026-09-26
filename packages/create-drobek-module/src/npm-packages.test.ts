/**
 * NSO-349: the release half of scripts/npm-packages.mjs (the CI `npm` job on
 * a `v*` tag) with a fake `npm` — nothing reaches a registry.
 */
import { describe, expect, it } from 'vitest';
import { NPM_PACKAGES, packageOf, privateImports, publishPackages } from '../../../scripts/npm-packages.mjs';

const staged = (version: string) => NPM_PACKAGES.map((p) => ({ name: p.name, version, dir: `/out/${p.dir}` }));

/** A fake `npm`: `view` answers from `published`, every call is recorded. */
function fakeNpm(published: string[]) {
  const calls: string[][] = [];
  const exec = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'view') {
      if (published.includes(args[1])) return '"x"\n';
      throw Object.assign(new Error('npm view failed'), { stderr: 'npm error code E404\nnpm error 404 Not Found' });
    }
    return '';
  };
  return { exec, calls };
}

describe('publishPackages', () => {
  it('publishes @drobek/sdk, @drobek/modules and create-drobek-module in that order, publicly', () => {
    const npm = fakeNpm([]);
    const r = publishPackages(staged('0.2.0'), { exec: npm.exec, log: () => {} });
    expect(r).toEqual([
      { name: '@drobek/sdk', action: 'published' },
      { name: '@drobek/modules', action: 'published' },
      { name: 'create-drobek-module', action: 'published' },
    ]);
    expect(npm.calls.filter((c) => c[1] === 'publish')).toEqual([
      ['npm', 'publish', '/out/drobek-sdk', '--access', 'public'],
      ['npm', 'publish', '/out/drobek-modules', '--access', 'public'],
      ['npm', 'publish', '/out/create-drobek-module', '--access', 'public'],
    ]);
  });

  it('skips a version that is already on the registry (a re-run of the tag)', () => {
    const npm = fakeNpm(['@drobek/sdk@0.2.0']);
    const r = publishPackages(staged('0.2.0'), { exec: npm.exec, log: () => {} });
    expect(r.map((x) => x.action)).toEqual(['skipped', 'published', 'published']);
    expect(npm.calls.some((c) => c[1] === 'publish' && c[2] === '/out/drobek-sdk')).toBe(false);
  });

  it('a pre-release goes to the dist-tag next; --dry-run is passed through', () => {
    const npm = fakeNpm([]);
    publishPackages(staged('0.3.0-rc.1'), { exec: npm.exec, log: () => {}, dryRun: true });
    for (const c of npm.calls.filter((x) => x[1] === 'publish')) expect(c.slice(-3)).toEqual(['--tag', 'next', '--dry-run']);
  });

  it('a registry failure other than 404 stops the release', () => {
    const exec = () => {
      throw Object.assign(new Error('boom'), { stderr: 'npm error code ECONNRESET' });
    };
    expect(() => publishPackages(staged('0.2.0'), { exec, log: () => {} })).toThrow(/boom/);
  });
});

describe('the declaration leak check', () => {
  it('finds imports of private packages, not comments or @drobek/sdk', () => {
    const dts = [
      "import { Redis } from 'ioredis';",
      "import type { SdkCore } from '@drobek/sdk';",
      ' *   import { createModuleTestContext } from \'@drobek/modules/testing\';',
      "export { x } from '@drobek/core';",
      'type D = import("@drobek/db").DB;',
      "import {\n  a,\n  b,\n} from '@drobek/apps';",
    ].join('\n');
    expect(privateImports(dts)).toEqual(['@drobek/core', '@drobek/db', '@drobek/apps']);
  });

  it('packageOf', () => {
    expect(packageOf('drizzle-orm/pg-core')).toBe('drizzle-orm');
    expect(packageOf('@paralleldrive/cuid2')).toBe('@paralleldrive/cuid2');
    expect(packageOf('@drobek/modules/testing')).toBe('@drobek/modules');
  });
});
