import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { DEFAULT_TYPECHECK_LIMITS, installTypecheckRunner, type TypecheckResult, type TypecheckRunner } from '@drobek/compile/typecheck';
import { appVersions, getDb, users, workspaces } from '@drobek/db';
import { createApp, createVersion, scheduleVersionTypecheck, versionReadiness, type Actor } from './index.js';
import { freshDb } from './test/db.js';

let close: () => Promise<void>;
let appId: string;
let actor: Actor;

beforeAll(async () => {
  const t = await freshDb();
  close = () => t.pg.close();
  const [u] = await t.db.insert(users).values({ email: 'types@example.test' }).returning();
  const [w] = await t.db.insert(workspaces).values({ kind: 'personal', slug: 'types', name: 'Types' }).returning();
  actor = { userId: u.id, kind: 'agent' };
  appId = (await createApp({ workspaceId: w.id, slug: 'typed-app', actor })).id;
});
afterAll(async () => close());
afterEach(() => installTypecheckRunner(null));

/** A runner that answers `result` without a worker. */
function fakeRunner(result: TypecheckResult | (() => Promise<TypecheckResult>)) {
  const run = vi.fn((_files: ReadonlyMap<string, string | Buffer>, _opts?: { group?: string; key?: string }) =>
    typeof result === 'function' ? result() : Promise.resolve(result)
  );
  installTypecheckRunner({ limits: DEFAULT_TYPECHECK_LIMITS, run } as unknown as TypecheckRunner);
  return run;
}

const HEAD = '<title>T</title><meta name="description" content="A typed app."><link rel="icon" href="/favicon.svg">';
const TITLED = { path: 'index.html', content: `<head>${HEAD}</head><body><script type="module" src="/main.js"></script></body>` };

async function tsVersion(main = 'export const n: number = 1;\n', status: 'ok' | 'error' = 'ok') {
  return createVersion(appId, [TITLED, { path: 'src/main.ts', content: main }], { actor, compile: { status } });
}

async function stored(versionId: string): Promise<unknown> {
  const [row] = await getDb().select({ typecheck: appVersions.typecheck }).from(appVersions).where(eq(appVersions.id, versionId));
  return row?.typecheck ?? null;
}

describe('the background type check in the readiness report', () => {
  it('without a runner (TYPECHECK_WORKERS=0) the report is unchanged — no typecheck field', async () => {
    const v = await tsVersion();
    expect(await versionReadiness(appId, { number: v.number })).toEqual({
      version: v.number,
      report: { ready: true, blocking: [], warnings: [] },
    });
  });

  it('pending until the check is stored, then its type errors are type_error warnings with the catalogue hint', async () => {
    const run = fakeRunner({
      status: 'checked',
      findings: [
        { file: 'src/main.ts', line: 3, message: "TS2551: Property 'lst' does not exist on type 'Data'. Did you mean 'list'?" },
        { file: 'src/a.ts', line: 1, message: "TS2322: Type 'string' is not assignable to type 'number'." },
      ],
      total: 5,
      durationMs: 120,
    });
    const v = await tsVersion();
    const first = await versionReadiness(appId, { number: v.number });
    expect(first?.report).toEqual({ ready: true, blocking: [], warnings: [], typecheck: 'pending' });
    expect(run).toHaveBeenCalledWith(expect.any(Map), { group: appId, key: v.id });
    await vi.waitFor(async () => expect(await stored(v.id)).not.toBeNull());

    const second = await versionReadiness(appId, { number: v.number });
    expect(second?.report.typecheck).toBe('checked');
    expect(second?.report.warnings.map((w) => `${w.code} ${w.file}:${w.line}`)).toEqual(['type_error src/a.ts:1', 'type_error src/main.ts:3']);
    expect(second?.report.warnings[1].hint).toMatch(/Fix the code at the reported line/);
    expect(second?.report.warnings_omitted).toBe(3);
    expect(second?.report.ready).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('type errors come after the other checks and share READINESS_MAX_WARNINGS', async () => {
    fakeRunner({ status: 'checked', findings: [{ file: 'src/main.ts', line: 1, message: 'TS2322: x' }], total: 1, durationMs: 1 });
    const v = await createVersion(appId, [{ path: 'index.html', content: `${HEAD.replace('<title>T</title>', '')}<p>no title</p>` }, { path: 'src/main.ts', content: 'x' }], {
      actor,
      compile: { status: 'ok' },
    });
    await versionReadiness(appId, { number: v.number });
    await vi.waitFor(async () => expect(await stored(v.id)).not.toBeNull());
    const all = await versionReadiness(appId, { number: v.number });
    expect(all?.report.warnings.map((w) => w.code)).toEqual(['missing_title', 'type_error']);
    const capped = await versionReadiness(appId, { number: v.number }, { limits: { maxWarnings: 1 } });
    expect(capped?.report.warnings.map((w) => w.code)).toEqual(['missing_title']);
    expect(capped?.report.warnings_omitted).toBe(1);
  });

  it('a check over a limit is stored as unavailable: no type warnings, never retried', async () => {
    const run = fakeRunner({ status: 'unavailable', reason: 'timeout', durationMs: 20_000 });
    const v = await tsVersion();
    await versionReadiness(appId, { number: v.number });
    await vi.waitFor(async () => expect(await stored(v.id)).toEqual({ status: 'unavailable', reason: 'timeout', duration_ms: 20_000 }));
    const r = await versionReadiness(appId, { number: v.number });
    expect(r?.report).toEqual({ ready: true, blocking: [], warnings: [], typecheck: 'unavailable' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a superseded check is not stored: reading the report schedules it again', async () => {
    const run = fakeRunner({ status: 'unavailable', reason: 'superseded', durationMs: 0 });
    const v = await tsVersion();
    expect((await versionReadiness(appId, { number: v.number }))?.report.typecheck).toBe('pending');
    await new Promise((r) => setTimeout(r, 20));
    expect(await stored(v.id)).toBeNull();
    expect((await versionReadiness(appId, { number: v.number }))?.report.typecheck).toBe('pending');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a version that did not compile, or has no .ts/.tsx file, is not checked', async () => {
    const run = fakeRunner({ status: 'checked', findings: [], total: 0, durationMs: 1 });
    const broken = await tsVersion('let =', 'error');
    expect((await versionReadiness(appId, { number: broken.number }))?.report.typecheck).toBeUndefined();
    const js = await createVersion(appId, [TITLED, { path: 'src/main.js', content: 'x.y()' }], { actor, compile: { status: 'ok' } });
    expect((await versionReadiness(appId, { number: js.number }))?.report).toEqual({ ready: true, blocking: [], warnings: [] });
    expect(run).not.toHaveBeenCalled();
  });

  it('a runner that rejects or a failed store is logged, never thrown', async () => {
    fakeRunner(() => Promise.reject(new Error('boom')));
    const log = { warn: vi.fn() };
    const v = await tsVersion();
    expect(scheduleVersionTypecheck({ id: v.id, appId }, new Map([['src/main.ts', 'x']]), log)).toBe('pending');
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith('typecheck result not stored', expect.objectContaining({ app_id: appId, version_id: v.id })));
    expect(await stored(v.id)).toBeNull();
  });

  it('scheduleVersionTypecheck answers undefined when there is nothing to check or no runner', () => {
    expect(scheduleVersionTypecheck({ id: 'v', appId }, new Map([['src/main.ts', 'x']]))).toBeUndefined();
    fakeRunner({ status: 'checked', findings: [], total: 0, durationMs: 0 });
    expect(scheduleVersionTypecheck({ id: 'v', appId }, new Map([['index.html', '<p>'], ['src/main.jsx', 'x']]))).toBeUndefined();
  });
});
