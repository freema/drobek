import { describe, expect, it } from 'vitest';
import { DataError } from './errors.js';
import {
  compileSchema,
  schemaPropertyNames,
  validateDocument,
} from './schema-validate.js';

const todoSchema = {
  type: 'object',
  required: ['title', 'done'],
  properties: {
    title: { type: 'string' },
    done: { type: 'boolean' },
    priority: { type: 'number' },
  },
  additionalProperties: false,
};

describe('validateDocument', () => {
  it('accepts a schema-honoring document', () => {
    expect(() =>
      validateDocument(todoSchema, { title: 'ship U10', done: false })
    ).not.toThrow();
  });

  it('rejects a document missing a required field with field errors', () => {
    try {
      validateDocument(todoSchema, { title: 'no done flag' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DataError);
      expect((err as DataError).code).toBe('validation_failed');
      expect(Array.isArray((err as DataError).details)).toBe(true);
      expect(JSON.stringify((err as DataError).details)).toContain('done');
    }
  });

  it('rejects a wrong-typed field', () => {
    expect(() =>
      validateDocument(todoSchema, { title: 42, done: true })
    ).toThrowError(DataError);
  });

  it('rejects an additional property when additionalProperties:false', () => {
    expect(() =>
      validateDocument(todoSchema, { title: 'x', done: true, sneaky: 1 })
    ).toThrowError(DataError);
  });

  it('rejects a non-object document', () => {
    try {
      validateDocument(todoSchema, [1, 2, 3]);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as DataError).code).toBe('validation_failed');
    }
  });
});

describe('compileSchema', () => {
  it('throws invalid_schema on a malformed schema', () => {
    try {
      compileSchema({ type: 123 });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as DataError).code).toBe('invalid_schema');
    }
  });

  it('throws invalid_schema on a non-object schema', () => {
    try {
      compileSchema('nope');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as DataError).code).toBe('invalid_schema');
    }
  });
});

describe('schemaPropertyNames', () => {
  it('returns the declared top-level property names', () => {
    expect([...schemaPropertyNames(todoSchema)].sort()).toEqual([
      'done',
      'priority',
      'title',
    ]);
  });

  it('returns an empty set when no properties are declared', () => {
    expect(schemaPropertyNames({ type: 'object' }).size).toBe(0);
  });
});
