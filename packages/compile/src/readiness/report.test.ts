import { describe, expect, it, vi } from 'vitest';
import { LIMITS, errorDoc, errorHint } from '@drobek/agent-dx';
import { READINESS_CHECKS } from './checks/index.js';
import { DEFAULT_READINESS_LIMITS, readinessLimitsFromEnv, readinessReport } from './report.js';
import type { ReadinessCheck } from './types.js';

const titled = new Map([['index.html', '<html><head><title>App</title></head></html>']]);
const untitled = new Map([['index.html', '<html><head></head></html>']]);

const fixed = (id: string, findings: { code: string; file?: string; line?: number }[], extra: Partial<ReadinessCheck> = {}): ReadinessCheck => ({
  id,
  codes: findings.map((f) => f.code),
  run: () => findings.map((f) => ({ ...f, message: `${f.code} here` })),
  ...extra,
});

describe('readinessReport', () => {
  it('is ready with no warnings for a clean version', async () => {
    expect(await readinessReport({ files: titled })).toEqual({ ready: true, blocking: [], warnings: [] });
  });

  it('turns compile errors into blocking findings with the catalogue hint (or the given one)', async () => {
    const report = await readinessReport({
      files: titled,
      blocking: [
        { code: 'build_error', file: 'src/main.tsx', line: 3, text: 'Expected ";"' },
        { code: 'unresolved_import', file: 'src/db.ts', line: null, text: 'firebase', hint: "skill_info('data')" },
        { text: 'no code' },
      ],
    });
    expect(report.ready).toBe(false);
    expect(report.blocking).toEqual([
      { code: 'build_error', file: 'src/main.tsx', line: 3, message: 'Expected ";"', hint: errorHint('build_error') },
      { code: 'unresolved_import', file: 'src/db.ts', message: 'firebase', hint: "skill_info('data')" },
      { code: 'build_error', message: 'no code', hint: errorHint('build_error') },
    ]);
  });

  it('runs the registered checks: a missing <title> is a warning, never blocking', async () => {
    const report = await readinessReport({ files: untitled });
    expect(report.ready).toBe(true);
    expect(report.blocking).toEqual([]);
    expect(report.warnings).toEqual([
      expect.objectContaining({ code: 'missing_title', file: 'index.html', line: 1, hint: errorHint('missing_title') }),
    ]);
  });

  it('orders warnings by check, then file and line — the same input gives the same report', async () => {
    const checks = [
      fixed('b', [{ code: 'x', file: 'b.ts', line: 9 }, { code: 'x', file: 'a.ts', line: 5 }, { code: 'x', file: 'a.ts', line: 2 }]),
      fixed('a', [{ code: 'y' }]),
    ];
    const one = await readinessReport({ files: titled, checks });
    const two = await readinessReport({ files: titled, checks });
    expect(one).toEqual(two);
    expect(one.warnings.map((w) => `${w.code}:${w.file ?? ''}:${w.line ?? ''}`)).toEqual(['x:a.ts:2', 'x:a.ts:5', 'x:b.ts:9', 'y::']);
  });

  it('caps the warnings at the limit and counts the rest', async () => {
    const checks = [fixed('many', Array.from({ length: 5 }, (_, i) => ({ code: 'x', file: 'f.ts', line: i + 1 })))];
    const report = await readinessReport({ files: titled, checks, limits: { maxWarnings: 2 } });
    expect(report.warnings).toHaveLength(2);
    expect(report.warnings_omitted).toBe(3);
  });

  it('a check that throws is left out and reported, never fails the report', async () => {
    const onCheckError = vi.fn();
    const boom: ReadinessCheck = { id: 'boom', codes: [], run: () => { throw new Error('bad'); } };
    const report = await readinessReport({ files: untitled, checks: [boom, ...READINESS_CHECKS], onCheckError });
    expect(report.warnings.map((w) => w.code)).toEqual(['missing_title']);
    expect(onCheckError).toHaveBeenCalledWith('boom', expect.any(Error));
  });

  it('loads module configs only when a check needs them, and a failed load skips only those checks', async () => {
    const loadModules = vi.fn(async () => [{ name: 'data', enabled: true, config: { collections: {} } }]);
    await readinessReport({ files: titled, loadModules, checks: READINESS_CHECKS.filter((c) => !c.needsModules) });
    expect(loadModules).not.toHaveBeenCalled();

    const seen: unknown[] = [];
    const needs: ReadinessCheck = { id: 'mods', codes: [], needsModules: true, run: ({ modules }) => { seen.push(modules); return []; } };
    await readinessReport({ files: titled, loadModules, checks: [needs] });
    expect(seen).toEqual([[{ name: 'data', enabled: true, config: { collections: {} } }]]);

    const onCheckError = vi.fn();
    const report = await readinessReport({
      files: untitled,
      loadModules: async () => { throw new Error('db down'); },
      checks: [needs, ...READINESS_CHECKS],
      onCheckError,
    });
    expect(onCheckError).toHaveBeenCalledWith('modules', expect.any(Error));
    expect(report.warnings.map((w) => w.code)).toEqual(['missing_title']);
  });
});

describe('the module rules audit in the report (NSO-386)', () => {
  it('reads the app\'s module configs and warns — never blocks', async () => {
    const report = await readinessReport({
      files: titled,
      loadModules: async () => [
        { name: 'auth', enabled: true, config: {} },
        { name: 'data', enabled: true, config: { collections: { wall: { rules: { read: 'public', create: 'public' } } } }, pending: ['data.x: y'] },
      ],
    });
    expect(report.ready).toBe(true);
    expect(report.blocking).toEqual([]);
    expect(report.warnings.map((w) => w.code)).toEqual(['data_public_write_no_schema', 'module_change_pending']);
    expect(report.warnings[0].hint).toBe(errorHint('data_public_write_no_schema'));
  });

  it('a clean app with module configs keeps a clean report', async () => {
    const report = await readinessReport({
      files: titled,
      loadModules: async () => [
        { name: 'auth', enabled: true, config: {} },
        { name: 'data', enabled: true, config: { collections: { todos: {} } } },
      ],
    });
    expect(report).toEqual({ ready: true, blocking: [], warnings: [] });
  });
});

describe('the readiness check registry', () => {
  it('has unique check ids and a catalogue entry for every code', () => {
    const ids = READINESS_CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of READINESS_CHECKS) for (const code of c.codes) expect(errorDoc(code), `${c.id}: ${code}`).toBeTruthy();
  });
});

describe('readinessLimitsFromEnv', () => {
  it('reads READINESS_MAX_WARNINGS, falling back to the default on a bad value', () => {
    expect(readinessLimitsFromEnv({})).toEqual(DEFAULT_READINESS_LIMITS);
    expect(readinessLimitsFromEnv({ READINESS_MAX_WARNINGS: '7' })).toEqual({ maxWarnings: 7 });
    expect(readinessLimitsFromEnv({ READINESS_MAX_WARNINGS: '0' })).toEqual(DEFAULT_READINESS_LIMITS);
    expect(readinessLimitsFromEnv({ READINESS_MAX_WARNINGS: 'x' })).toEqual(DEFAULT_READINESS_LIMITS);
  });

  it('the agent-facing limits catalogue states the same default', () => {
    expect(LIMITS.find((l) => l.env === 'READINESS_MAX_WARNINGS')?.default).toBe(String(DEFAULT_READINESS_LIMITS.maxWarnings));
  });
});
