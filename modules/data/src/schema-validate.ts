/**
 * JSON-Schema validation for collection records — PURE (ajv), unit tested in
 * isolation. A collection's schema is compiled when the config is validated
 * (configure_module refuses a malformed one) and every write is validated
 * against it server-side; an invalid record is rejected with actionable,
 * secret-free field errors (422 validation_failed).
 */
import { Ajv, type ValidateFunction } from 'ajv';
import { Lru, jsonKey } from '@drobek/modules';
import { DataError } from './errors.js';

/**
 * A shared strict-ish Ajv. `allErrors` so a rejection lists every offending
 * field. `strict:false` keeps common vibecoded schemas (extra keywords,
 * missing `type`) from being rejected outright — the goal is data integrity,
 * not schema pedantry.
 */
function makeAjv(): InstanceType<typeof Ajv> {
  return new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
}

/**
 * Compiled validators by the schema's CONTENT (sha256 of its stable JSON) —
 * NSO-322 H1. The config is re-parsed into fresh objects, so an identity-keyed
 * cache never hit and every parse recompiled every collection's schema (~2 ms
 * each). A failed compile is cached too (as its message).
 */
const SCHEMA_CACHE_ENTRIES = 500;
const cache = new Lru<ValidateFunction | { error: string }>(SCHEMA_CACHE_ENTRIES);

/** Compiles done so far (tests). */
export const schemaCompileStats = { compiles: 0 };

/** A JSON Schema must be a plain object. */
function assertSchemaShape(jsonSchema: unknown): Record<string, unknown> {
  if (typeof jsonSchema !== 'object' || jsonSchema === null || Array.isArray(jsonSchema)) {
    throw new DataError('invalid_schema', 'schema must be a JSON Schema object');
  }
  return jsonSchema as Record<string, unknown>;
}

/**
 * Compile a collection schema, throwing `invalid_schema` if ajv cannot compile
 * it. Returns the validator (memoized by the schema's content).
 */
export function compileSchema(jsonSchema: unknown): ValidateFunction {
  const schema = assertSchemaShape(jsonSchema);
  const key = jsonKey(schema);
  let entry = cache.get(key);
  if (!entry) {
    schemaCompileStats.compiles += 1;
    try {
      // ajv keeps a reference to the schema: compile a private copy.
      entry = makeAjv().compile(structuredClone(schema));
    } catch (err) {
      entry = { error: (err as Error).message };
    }
    cache.set(key, entry);
  }
  if (typeof entry !== 'function') throw new DataError('invalid_schema', `schema does not compile: ${entry.error}`);
  return entry;
}

interface FieldError {
  path: string;
  message: string;
}

/**
 * Validate `doc` against `jsonSchema`. Throws `validation_failed` with the ajv
 * field errors on a mismatch. The record must itself be a plain object.
 */
export function validateDocument(jsonSchema: unknown, doc: unknown): void {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new DataError('validation_failed', 'a record must be a JSON object', {
      details: [{ path: '', message: 'expected an object' }],
    });
  }
  const validate = compileSchema(jsonSchema);
  if (!validate(doc)) {
    const errors: FieldError[] = (validate.errors ?? []).map((e) => ({
      path: e.instancePath || (e.params as { missingProperty?: string })?.missingProperty || '',
      message: e.message ?? 'invalid',
    }));
    throw new DataError('validation_failed', 'the record does not match the collection schema', { details: errors });
  }
}

/**
 * The set of top-level property names declared by a collection schema — with
 * a schema, the ONLY fields a query may filter/sort on. Empty when the schema
 * declares no `properties`.
 */
export function schemaPropertyNames(jsonSchema: unknown): Set<string> {
  const schema = assertSchemaShape(jsonSchema);
  const props = schema.properties;
  if (typeof props !== 'object' || props === null || Array.isArray(props)) {
    return new Set();
  }
  return new Set(Object.keys(props as Record<string, unknown>));
}
