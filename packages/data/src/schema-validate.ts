/**
 * JSON-Schema validation for collection documents (U10, PHY-55) — PURE (ajv),
 * unit tested in isolation. A collection's `json_schema` is compiled once at
 * define time (rejecting a malformed schema) and every write is validated
 * against it server-side; an invalid document is rejected with actionable,
 * secret-free field errors → the tool/REST layer maps that to 422.
 */
import { Ajv, type ValidateFunction } from 'ajv';
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

/** A JSON Schema must be a plain object. */
export function assertSchemaShape(jsonSchema: unknown): Record<string, unknown> {
  if (
    typeof jsonSchema !== 'object' ||
    jsonSchema === null ||
    Array.isArray(jsonSchema)
  ) {
    throw new DataError(
      'invalid_schema',
      'jsonSchema must be a JSON Schema object'
    );
  }
  return jsonSchema as Record<string, unknown>;
}

/**
 * Compile a collection schema, throwing `invalid_schema` if ajv cannot compile
 * it. Returns the validator so callers can reuse it.
 */
export function compileSchema(jsonSchema: unknown): ValidateFunction {
  const schema = assertSchemaShape(jsonSchema);
  try {
    return makeAjv().compile(schema);
  } catch (err) {
    throw new DataError(
      'invalid_schema',
      `jsonSchema does not compile: ${(err as Error).message}`
    );
  }
}

export interface FieldError {
  path: string;
  message: string;
}

/**
 * Validate `doc` against `jsonSchema`. Throws `validation_failed` with the ajv
 * field errors on a mismatch. The document must itself be a plain object.
 */
export function validateDocument(jsonSchema: unknown, doc: unknown): void {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new DataError('validation_failed', 'document must be a JSON object', [
      { path: '', message: 'expected an object' },
    ]);
  }
  const validate = compileSchema(jsonSchema);
  if (!validate(doc)) {
    const errors: FieldError[] = (validate.errors ?? []).map((e) => ({
      path: e.instancePath || (e.params as { missingProperty?: string })?.missingProperty || '',
      message: e.message ?? 'invalid',
    }));
    throw new DataError('validation_failed', 'document failed schema validation', errors);
  }
}

/**
 * The set of top-level property names declared by a collection schema — the
 * ONLY fields a query may filter/sort on (no injection, no probing arbitrary
 * jsonb keys). Empty when the schema declares no `properties`.
 */
export function schemaPropertyNames(jsonSchema: unknown): Set<string> {
  const schema = assertSchemaShape(jsonSchema);
  const props = schema.properties;
  if (typeof props !== 'object' || props === null || Array.isArray(props)) {
    return new Set();
  }
  return new Set(Object.keys(props as Record<string, unknown>));
}
