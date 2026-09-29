import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TYPECHECK_LIMITS, TypecheckRunner, installTypecheckRunner, typecheckLimitsFromEnv, typecheckRunner } from './runner.js';

const here = dirname(fileURLToPath(import.meta.url));
// Inside the package's node_modules, so the bundled worker resolves typescript and @types/react like dist/ does.
const dir = join(here, '../../node_modules/.typecheck-runner-test');
const SDK = { dts: 'export declare const drobek: { ping(): Promise<string> };', inline: {} };
const TS_APP = new Map<string, string | Buffer>([
  ['src/main.ts', "import { drobek } from 'drobek';\nconst n: number = await drobek.ping();\nexport { n };\n"],
  ['logo.png', Buffer.from([1, 2, 3])],
]);

function fixture(name: string, code: string): string {
  const path = join(dir, name);
  writeFileSync(path, code);
  return path;
}

let realWorker: string;
beforeAll(async () => {
  mkdirSync(dir, { recursive: true });
  realWorker = join(dir, 'worker.mjs');
  await esbuild.build({
    entryPoints: [join(here, 'worker.ts')],
    outfile: realWorker,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['typescript'],
    logLevel: 'silent',
  });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const limits = (over: Partial<typeof DEFAULT_TYPECHECK_LIMITS> = {}) => ({ ...DEFAULT_TYPECHECK_LIMITS, ...over });

describe('typecheckLimitsFromEnv', () => {
  it('has production defaults and reads TYPECHECK_*', () => {
    expect(typecheckLimitsFromEnv({})).toEqual(DEFAULT_TYPECHECK_LIMITS);
    expect(
      typecheckLimitsFromEnv({ TYPECHECK_WORKERS: '0', TYPECHECK_TIMEOUT_MS: '500', TYPECHECK_MAX_MEMORY_MB: '128', TYPECHECK_MAX_FILES: '3' })
    ).toEqual({ workers: 0, timeoutMs: 500, maxMemoryMb: 128, maxFiles: 3 });
    expect(typecheckLimitsFromEnv({ TYPECHECK_WORKERS: '-1', TYPECHECK_TIMEOUT_MS: 'x' })).toEqual(DEFAULT_TYPECHECK_LIMITS);
  });
});

describe('TypecheckRunner', () => {
  it('checks in a worker thread and reports the type errors', async () => {
    const runner = new TypecheckRunner({ limits: limits(), sdk: SDK, workerPath: realWorker });
    try {
      const r = await runner.run(TS_APP);
      expect(r).toMatchObject({ status: 'checked', total: 1, findings: [{ file: 'src/main.ts', line: 2 }] });
      if (r.status === 'checked') expect(r.findings[0].message).toMatch(/^TS2322: Type 'string' is not assignable to type 'number'/);
      const again = await runner.run(new Map([['src/main.ts', 'export const ok: string = "x";\n']]));
      expect(again).toMatchObject({ status: 'checked', total: 0, findings: [] });
    } finally {
      await runner.close();
    }
  });

  it('does not start a worker for an app without .ts/.tsx files', async () => {
    const runner = new TypecheckRunner({ limits: limits(), sdk: SDK, workerPath: '/nonexistent/worker.js' });
    expect(await runner.run(new Map([['index.html', '<p>hi</p>'], ['src/main.js', 'x.y()']]))).toEqual({
      status: 'checked',
      findings: [],
      total: 0,
      durationMs: 0,
    });
  });

  it('refuses an app over TYPECHECK_MAX_FILES without starting a worker', async () => {
    const runner = new TypecheckRunner({ limits: limits({ maxFiles: 1 }), sdk: SDK, workerPath: '/nonexistent/worker.js' });
    const r = await runner.run(new Map([['a.ts', ''], ['b.ts', '']]));
    expect(r).toMatchObject({ status: 'unavailable', reason: 'too_many_files' });
  });

  it('terminates a check over TYPECHECK_TIMEOUT_MS, logs it and keeps working', async () => {
    const hang = fixture(
      'hang.mjs',
      "import { parentPort } from 'node:worker_threads';\nparentPort.on('message', (j) => { if (j.files['slow.ts'] !== undefined) { for (;;) {} } parentPort.postMessage({ id: j.id, ok: true, findings: [], total: 0 }); });\n"
    );
    const log = { warn: vi.fn() };
    const runner = new TypecheckRunner({ limits: limits({ timeoutMs: 200 }), sdk: SDK, workerPath: hang, log });
    try {
      expect(await runner.run(new Map([['slow.ts', '']]))).toMatchObject({ status: 'unavailable', reason: 'timeout' });
      expect(log.warn).toHaveBeenCalledWith('typecheck timed out', { timeout_ms: 200 });
      expect(await runner.run(new Map([['fast.ts', '']]))).toMatchObject({ status: 'checked', total: 0 });
    } finally {
      await runner.close();
    }
  });

  it('reports a worker over TYPECHECK_MAX_MEMORY_MB as memory, never throws', async () => {
    const hog = fixture(
      'hog.mjs',
      "import { parentPort } from 'node:worker_threads';\nparentPort.on('message', () => { const keep = []; for (;;) keep.push(new Array(1e5).fill({ a: 1 })); });\n"
    );
    const log = { warn: vi.fn() };
    const runner = new TypecheckRunner({ limits: limits({ maxMemoryMb: 32, timeoutMs: 30_000 }), sdk: SDK, workerPath: hog, log });
    try {
      expect(await runner.run(new Map([['a.ts', '']]))).toMatchObject({ status: 'unavailable', reason: 'memory' });
      expect(log.warn).toHaveBeenCalledWith('typecheck ran out of memory', { max_memory_mb: 32 });
    } finally {
      await runner.close();
    }
  }, 30_000);

  it('reports a crashed worker as crashed', async () => {
    const crash = fixture('crash.mjs', "import { parentPort } from 'node:worker_threads';\nparentPort.on('message', () => { throw new Error('boom'); });\n");
    const runner = new TypecheckRunner({ limits: limits(), sdk: SDK, workerPath: crash, log: { warn: () => {} } });
    try {
      expect(await runner.run(new Map([['a.ts', '']]))).toMatchObject({ status: 'unavailable', reason: 'crashed' });
    } finally {
      await runner.close();
    }
  });

  it('keeps TYPECHECK_WORKERS checks running and collapses queued checks of one group to the newest', async () => {
    const slow = fixture(
      'slow.mjs',
      "import { parentPort } from 'node:worker_threads';\nparentPort.on('message', (j) => setTimeout(() => parentPort.postMessage({ id: j.id, ok: true, findings: [], total: Object.keys(j.files).length }), 100));\n"
    );
    const runner = new TypecheckRunner({ limits: limits({ workers: 1 }), sdk: SDK, workerPath: slow });
    try {
      const first = runner.run(new Map([['a.ts', '']]), { group: 'app1' });
      const second = runner.run(new Map([['a.ts', ''], ['b.ts', '']]), { group: 'app1' });
      const third = runner.run(new Map([['a.ts', ''], ['b.ts', ''], ['c.ts', '']]), { group: 'app1' });
      expect(runner.stats()).toEqual({ active: 1, queued: 1 });
      expect(await first).toMatchObject({ status: 'checked', total: 1 });
      expect(await second).toMatchObject({ status: 'unavailable', reason: 'superseded' });
      expect(await third).toMatchObject({ status: 'checked', total: 3 });
    } finally {
      await runner.close();
    }
  });

  it('is process-wide through installTypecheckRunner, and off with TYPECHECK_WORKERS=0', async () => {
    const on = new TypecheckRunner({ limits: limits(), sdk: SDK });
    installTypecheckRunner(on);
    expect(typecheckRunner()).toBe(on);
    installTypecheckRunner(new TypecheckRunner({ limits: limits({ workers: 0 }), sdk: SDK }));
    expect(typecheckRunner()).toBeNull();
    installTypecheckRunner(null);
    expect(typecheckRunner()).toBeNull();
  });
});
