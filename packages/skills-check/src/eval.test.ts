import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { findApiMisuse, parseSdkDts } from '../../../tests-eval/lib.mjs';
import { buildSdk } from '@drobek/modules';
import { codeBlocks } from '@drobek/modules/testing';
import { BUILTIN_MODULES, REPO_ROOT, skillSources } from './skills.js';

/**
 * NSO-308: the manual agent eval (tests-eval/) is not run in CI, but its
 * parsers are: the "non-existent API" detector must understand the REAL
 * generated sdk.d.ts (not only its fixture) and must not flag anything the
 * skills themselves teach — else the eval metric would be noise.
 */
let dts: string;
beforeAll(async () => {
  dts = (await buildSdk(BUILTIN_MODULES)).dts;
});

describe('tests-eval parsers against the live SDK', () => {
  it('parseSdkDts reads every module, its Api members, the inline exports and the root exports', () => {
    const sdk = parseSdkDts(dts);
    expect([...sdk.modules.keys()].sort()).toEqual(['auth', 'data', 'email', 'files', 'forms', 'proxy']);
    expect([...(sdk.modules.get('auth') ?? [])]).toEqual(expect.arrayContaining(['me', 'sendCode', 'verify', 'logout']));
    expect(sdk.modules.get('data')?.has('collection')).toBe(true);
    expect(sdk.modules.get('proxy')?.has('fetch')).toBe(true);
    expect(sdk.modules.get('files')?.has('upload')).toBe(true);
    expect([...(sdk.inline.get('auth') ?? [])]).toEqual(expect.arrayContaining(['LoginGate', 'useAuth', 'User']));
    expect(sdk.inline.get('forms')?.has('Form')).toBe(true);
    expect(sdk.root.has('drobek') && sdk.root.has('DrobekError')).toBe(true);
  });

  it('no skill example uses an API the eval would count as non-existent', async () => {
    const sdk = parseSdkDts(dts);
    const ext: Record<string, string> = { ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', html: 'html' };
    const files: [string, string][] = [];
    for (const s of await skillSources()) {
      for (const b of codeBlocks(s.content)) {
        if (ext[b.lang]) files.push([`${s.name}/${b.index}.${ext[b.lang]}`, b.code]);
      }
    }
    expect(files.length).toBeGreaterThan(20);
    expect(findApiMisuse(files, sdk)).toEqual([]);
  });

  it('flags made-up members, inline exports, modules and routes', () => {
    const sdk = parseSdkDts(dts);
    const code = [
      "import { drobek } from 'drobek';",
      "import { LoginGate, SignupGate } from 'drobek/auth';",
      "import { Chart } from 'drobek/charts';",
      'await drobek.auth.signup("x");',
      'await drobek.payments.charge(1);',
      "await fetch('/__drobek/v1/kv/x');",
      'void drobek.data.collection("todos"); void LoginGate;',
    ].join('\n');
    expect(findApiMisuse([['src/main.tsx', code]], sdk).map((m) => `${m.kind} ${m.name}`)).toEqual([
      'member drobek.auth.signup',
      'module drobek.payments',
      "inline SignupGate from 'drobek/auth'",
      'inline drobek/charts',
      'route /__drobek/v1/kv',
    ]);
  });

  it('run.mjs --self-check passes on the fixtures', () => {
    const r = spawnSync(process.execPath, [join(REPO_ROOT, 'tests-eval', 'run.mjs'), '--self-check'], { encoding: 'utf8' });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('self-check: all');
  });
});
