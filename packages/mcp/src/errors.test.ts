import { describe, expect, it } from 'vitest';
import { ERROR_CATALOGUE, errorDoc } from '@drobek/agent-dx';
import type { CompileErrorCode } from '@drobek/compile';
import { CORE_ERROR_CODES, MODULE_ERROR_CODE_RE, MODULE_ERROR_CODES } from '@drobek/modules';
import { noopLogger } from '@drobek/core';
import { TOOL_ERROR_CODES, ToolError } from './errors.js';
import { connect, testDeps } from './test/harness.js';

/** Every @drobek/compile error code (exhaustive: adding one breaks the type). */
const COMPILE_CODES: Record<CompileErrorCode, true> = {
  build_error: true,
  unresolved_import: true,
  limit_exceeded: true,
  secret_in_source: true,
  invalid_path: true,
  invalid_config: true,
  timeout: true,
  busy: true,
  missing_reference: true,
  blocked_by_csp: true,
};

describe('error catalogue coverage', () => {
  it('every code a tool can emit has a catalogue entry (and a hint)', () => {
    for (const code of TOOL_ERROR_CODES) {
      expect(errorDoc(code), code).toBeTruthy();
      expect(new ToolError(code, 'm').toBody().hint).toBe(errorDoc(code)!.fix);
    }
  });

  it('every compile.errors[] / compile.warnings[] code has a catalogue entry', () => {
    for (const code of Object.keys(COMPILE_CODES)) expect(errorDoc(code), code).toBeTruthy();
  });

  it('every module-route error code (DrobekError) has a catalogue entry', () => {
    for (const code of MODULE_ERROR_CODES) expect(errorDoc(code), code).toBeTruthy();
  });

  it('CORE_ERROR_CODES (what a module may not declare, and may always answer) equals the catalogue', () => {
    const catalogue = ERROR_CATALOGUE.map((e) => e.code).filter((c) => MODULE_ERROR_CODE_RE.test(c));
    expect([...CORE_ERROR_CODES].sort()).toEqual([...new Set(catalogue)].sort());
  });

  it('module-specific codes live in their modules, not in the core catalogue', () => {
    for (const code of ['email_not_allowed', 'invalid_code', 'too_many_attempts', 'invalid_form_token', 'submitted_too_fast', 'validation_failed', 'unsupported_type', 'ssrf_blocked', 'proxy_busy', 'path_not_allowed', 'upstream_error', 'upstream_redirect', 'config_error']) {
      expect(errorDoc(code), code).toBeUndefined();
    }
  });

  it('the catalogue has no duplicate codes and documents compile_error', () => {
    const codes = ERROR_CATALOGUE.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain('compile_error');
    expect(codes).not.toContain('not_member');
  });

  it('the body is { code, message, hint, ...details }', () => {
    const body = new ToolError('app_locked', 'busy', { holder: 'al***@x.test', expires_at: 'T' }).toBody();
    expect(Object.keys(body)).toEqual(['code', 'message', 'hint', 'holder', 'expires_at']);
  });
});

describe('a tool that fails unexpectedly', () => {
  const principal = { userId: 'u', email: 'u@example.test', superAdmin: false };
  const EMAIL = 'owner.secret@corp.example';

  async function failWith(err: unknown) {
    const logged: string[] = [];
    const deps = {
      ...testDeps(),
      log: { ...noopLogger, error: (_m: string, meta?: Record<string, unknown>) => void logged.push(String(meta?.error)) },
      modules: () => Promise.reject(err),
    };
    const mcp = await connect(principal, deps);
    try {
      return { ...(await mcp.call('skill_info')), logged };
    } finally {
      await mcp.close();
    }
  }

  function drizzleWrapped(code: string): Error {
    const cause = Object.assign(new Error('canceling statement due to statement timeout'), { name: 'PostgresError', severity: 'ERROR', code });
    return Object.assign(new Error(`Failed query: select 1\nparams: ${EMAIL}`, { cause }), { query: 'select 1', params: [EMAIL] });
  }

  it('a query the database cut off answers busy (reason database_timeout), never the raw message', async () => {
    for (const code of ['57014', '55P03']) {
      const r = await failWith(drizzleWrapped(code));
      expect(r.isError).toBe(true);
      expect(r.body).toMatchObject({ code: 'busy', reason: 'database_timeout', hint: errorDoc('busy')!.fix });
      expect(r.text).not.toMatch(/canceling|Failed query/);
      expect(r.text).not.toContain(EMAIL);
      expect(r.logged[0]?.split('\n')[0]).toBe(`db error ${code}`);
    }
  });

  it('any other error stays internal_error', async () => {
    const r = await failWith(drizzleWrapped('23505'));
    expect(r.body).toMatchObject({ code: 'internal_error' });
    expect(r.text).not.toContain(EMAIL);
  });
});
