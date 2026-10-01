/**
 * The core-hosted `errors.reporter` slot: the contribution schema, the
 * selection by ERROR_REPORTER and the start refusals, with the errorsink
 * fixture loaded from DROBEK_MODULES_DIR the way an operator installs it.
 * That a module route throw and a failed job reach the reporter is in
 * runtime.test.ts and jobs.test.ts.
 */
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { installedErrorReporterId, noopLogger, reportError, resetErrorReporterForTests, type ErrorReportEvent } from '@drobek/core';
import { defineModule, type AnyModule } from './contract.js';
import { ERROR_REPORTER_SLOT, defineErrorReporter, errorReporterSchema, installModuleErrorReporter, selectErrorReporter } from './error-reporter-slot.js';
import { checkModuleSet, loadModuleSet, validateModule } from './registry.js';
import { loadModuleRuntime } from './runtime.js';
import { ERRORSINK_FIXTURE, installDirModule, tempModulesDir } from './test/modules-dir.js';

const TOKEN = 'es_test_fake_token_0123456789';
const INBOX = Symbol.for('drobek.test.errorsink.inbox');
type Inbox = { event: ErrorReportEvent; token: string }[];
const inbox = (): Inbox => ((globalThis as Record<symbol, unknown>)[INBOX] ??= []) as Inbox;

function reporterModule(name: string, reporter: Record<string, unknown>): AnyModule {
  return defineModule({
    name,
    version: '1.0.0',
    contract: '^1.2',
    skill: { useWhen: 'a test', markdown: `# ${name}\n` },
    configSchema: z.object({}),
    configDefaults: {},
    contributes: { [ERROR_REPORTER_SLOT]: reporter },
  });
}

const noBuiltins = async (pkg: string): Promise<never> => {
  throw new Error(`Cannot find package '${pkg}'`);
};

const dirs: string[] = [];
async function loadWithSink(env: Record<string, string> = {}) {
  const dir = tempModulesDir();
  dirs.push(dir);
  installDirModule(dir, { name: 'errorsink', from: ERRORSINK_FIXTURE });
  return loadModuleSet({ NODE_ENV: 'test', DROBEK_MODULES: 'errorsink', ...env }, { modulesDir: dir, log: noopLogger, importer: noBuiltins });
}

const ENV = { ERROR_REPORTER: 'errorsink', ERRORSINK_TOKEN: TOKEN };

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetErrorReporterForTests();
  inbox().length = 0;
});

describe('the errors.reporter contribution schema', () => {
  const ok = { id: 'pager', label: 'Pager', secrets: ['PAGER_TOKEN'], report: async () => {} };

  it('accepts a reporter with or without apiVersion 1', () => {
    expect(errorReporterSchema.safeParse(ok).success).toBe(true);
    expect(errorReporterSchema.safeParse({ ...ok, apiVersion: 1 }).success).toBe(true);
    expect(errorReporterSchema.safeParse(defineErrorReporter({ id: 'hook', label: 'Webhook', report: () => {} })).success).toBe(true);
  });

  it('refuses a bad id, apiVersion, label, secret names and a missing report', () => {
    const issue = (v: unknown) => {
      const r = errorReporterSchema.safeParse(v);
      return r.success ? null : r.error.issues.map((i) => i.message).join('; ');
    };
    expect(issue({ ...ok, id: 'Sen-try' })).toMatch(/lowercase letters and digits/);
    expect(issue({ ...ok, apiVersion: 2 })).toMatch(/not an error reporter API this server implements \(1\)/);
    expect(issue({ ...ok, label: 'Two\nlines' })).toMatch(/one trimmed line/);
    expect(issue({ ...ok, secrets: ['pager_token'] })).toMatch(/UPPER_SNAKE/);
    expect(issue({ ...ok, secrets: ['A_B', 'A_B'] })).toMatch(/twice/);
    expect(issue({ ...ok, report: 'nope' })).toMatch(/report must be a function/);
  });

  it('is hosted by core: no host module is needed, a bad contribution and a duplicate id refuse the start', () => {
    expect(() => checkModuleSet([reporterModule('one', ok)], {})).not.toThrow();
    expect(() => checkModuleSet([reporterModule('one', { ...ok, id: 'X' })], {})).toThrow(
      /module "one": its contribution to the slot "errors\.reporter" \(hosted by core\) does not pass the slot's schema — id:/
    );
    expect(() => checkModuleSet([reporterModule('one', ok), reporterModule('two', ok)], {})).toThrow(
      /modules "one" and "two" both contribute id "pager" to the slot "errors\.reporter"/
    );
  });

  it('no module may take the name "errors" (it is the prefix of the core slot)', () => {
    const squatter = defineModule({
      name: 'errors',
      version: '1.0.0',
      contract: '^1.2',
      skill: { useWhen: 'x', markdown: '# x\n' },
      configSchema: z.object({}),
      configDefaults: {},
    });
    expect(() => validateModule(squatter)).toThrow(/reserved/);
  });
});

describe('selection by ERROR_REPORTER', () => {
  it('unset selects nothing and uninstalls a previous reporter', async () => {
    const { modules } = await loadWithSink();
    expect(selectErrorReporter(modules, {})).toBeNull();
    installModuleErrorReporter(modules, ENV);
    expect(installedErrorReporterId()).toBe('errorsink');
    installModuleErrorReporter(modules, {});
    expect(installedErrorReporterId()).toBeNull();
  });

  it('ERROR_REPORTER=errorsink: the dir module reporter gets the events, with the env token, never logged', async () => {
    const { modules } = await loadWithSink(ENV);
    expect(selectErrorReporter(modules, ENV)).toMatchObject({ module: 'errorsink', reporter: { id: 'errorsink' } });
    const infos: unknown[] = [];
    installModuleErrorReporter(modules, ENV, { ...noopLogger, info: (...a: unknown[]) => void infos.push(a) });
    expect(JSON.stringify(infos)).not.toContain(TOKEN);
    await reportError({ message: 'e-mail could not be sent', error: new Error(`relay said no to ana@example.com (${TOKEN})`), context: { kind: 'email' } });
    expect(inbox()).toHaveLength(1);
    expect(inbox()[0]!.token).toBe(TOKEN);
    expect(inbox()[0]!.event.error!.message).toBe('relay said no to [email] ([redacted])');
  });

  it('a reporter that throws is logged with its secret redacted; the caller never sees it', async () => {
    const { modules } = await loadWithSink(ENV);
    const warns: unknown[] = [];
    installModuleErrorReporter(modules, ENV, { ...noopLogger, warn: (...a: unknown[]) => void warns.push(a) });
    await expect(reportError({ message: 'explode', context: { kind: 'http' } })).resolves.toBeUndefined();
    expect(JSON.stringify(warns)).toContain('sink refused token [redacted]');
    expect(JSON.stringify(warns)).not.toContain(TOKEN);
  });

  it('refuses the start without the module that contributes the id (never echoing the env value)', async () => {
    await expect(loadModuleRuntime({ env: { ...ENV, ERROR_REPORTER: 'pager', DROBEK_MIGRATE_ON_START: '0' }, modules: [], skillsDir: null, log: noopLogger })).rejects.toThrow(
      /ERROR_REPORTER names no error reporter of the active modules \(available: none\) — add the module that contributes it to DROBEK_MODULES, or unset ERROR_REPORTER/
    );
    const { modules } = await loadWithSink();
    const run = () => selectErrorReporter(modules, { ERROR_REPORTER: 'pager' });
    expect(run).toThrow(/available: errorsink\)/);
    expect(run).not.toThrow(/pager/);
  });

  it('refuses the start when the env lacks a declared secret', async () => {
    const { modules } = await loadWithSink();
    expect(() => installModuleErrorReporter(modules, { ERROR_REPORTER: 'errorsink', ERRORSINK_TOKEN: ' ' })).toThrow(
      /the error reporter "errorsink" \(module "errorsink"\) needs ERRORSINK_TOKEN in the server env/
    );
    expect(installedErrorReporterId()).toBeNull();
  });
});
