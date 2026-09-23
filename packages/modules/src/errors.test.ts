import { describe, expect, it } from 'vitest';
import { ModuleError, isModuleError } from './errors.js';

describe('isModuleError', () => {
  it('recognises instances and subclasses', () => {
    class DataError extends ModuleError {
      constructor() {
        super('payload_too_large', 'too big', { status: 413 });
        this.name = 'DataError';
      }
    }
    expect(isModuleError(new ModuleError('not_found', 'x'))).toBe(true);
    expect(isModuleError(new DataError())).toBe(true);
  });

  it('recognises a subclass thrown by another copy of this package (no instanceof, renamed)', () => {
    // Simulate a second module instance: same shape + shared Symbol.for brand, foreign prototype.
    const foreign = Object.assign(new Error('too big'), {
      name: 'DataError',
      code: 'payload_too_large',
      status: 413,
      headers: {},
      body: () => ({ error: 'payload_too_large', message: 'too big' }),
      [Symbol.for('drobek.module-error')]: true,
    });
    expect(isModuleError(foreign)).toBe(true);
  });

  it('rejects plain errors and look-alikes without the brand or the name', () => {
    expect(isModuleError(new Error('nope'))).toBe(false);
    expect(isModuleError({ name: 'DataError', status: 413, body: () => ({}) })).toBe(false);
    expect(isModuleError(null)).toBe(false);
  });
});
