import { describe, expect, it } from 'vitest';
import { ERROR_CATALOGUE, errorDoc } from '@drobek/agent-dx';
import type { CompileErrorCode } from '@drobek/compile';
import { MODULE_ERROR_CODES } from '@drobek/modules';
import { TOOL_ERROR_CODES, ToolError } from './errors.js';

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
};

describe('error catalogue coverage', () => {
  it('every code a tool can emit has a catalogue entry (and a hint)', () => {
    for (const code of TOOL_ERROR_CODES) {
      expect(errorDoc(code), code).toBeTruthy();
      expect(new ToolError(code, 'm').toBody().hint).toBe(errorDoc(code)!.fix);
    }
  });

  it('every compile.errors[] code has a catalogue entry', () => {
    for (const code of Object.keys(COMPILE_CODES)) expect(errorDoc(code), code).toBeTruthy();
  });

  it('every module-route error code (DrobekError) has a catalogue entry (M1-01)', () => {
    for (const code of MODULE_ERROR_CODES) expect(errorDoc(code), code).toBeTruthy();
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
