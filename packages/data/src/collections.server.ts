/**
 * Collection definition + lookup (U10, PHY-55/PHY-56). `defineCollection`
 * compiles the JSON Schema (rejecting a malformed one) and upserts by
 * (app_id, name); it requires an editor+ caller (checked at the tool/REST
 * boundary). Reads/writes resolve the collection via `getCollection`.
 */
import { and, eq } from 'drizzle-orm';
import { collections, getDb } from '@drobek/db';
import { isAccessMode, type AccessMode } from './access.js';
import { DataError } from './errors.js';
import { compileSchema } from './schema-validate.js';

export interface CollectionRow {
  id: string;
  appId: string;
  name: string;
  jsonSchema: unknown;
  accessMode: AccessMode;
}

const COLLECTION_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/i;

function assertCollectionName(name: string): void {
  if (!COLLECTION_NAME_RE.test(name)) {
    throw new DataError(
      'invalid_request',
      'collection name must be 1–64 chars, start with a letter, and contain only letters, digits, "-" or "_"'
    );
  }
}

/** Load a collection by (appId, name), or throw not_found. */
export async function getCollection(
  appId: string,
  name: string
): Promise<CollectionRow> {
  const rows = await getDb()
    .select({
      id: collections.id,
      appId: collections.appId,
      name: collections.name,
      jsonSchema: collections.jsonSchema,
      accessMode: collections.accessMode,
    })
    .from(collections)
    .where(and(eq(collections.appId, appId), eq(collections.name, name)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new DataError('not_found', `collection "${name}" not found`);
  }
  return { ...row, accessMode: row.accessMode as AccessMode };
}

export interface DefineCollectionInput {
  appId: string;
  name: string;
  jsonSchema: unknown;
  accessMode: string;
}

export interface DefineCollectionResult {
  id: string;
  name: string;
  accessMode: AccessMode;
  created: boolean;
}

/**
 * Create or update a collection's schema + access mode. The schema must compile
 * under ajv (else invalid_schema). Idempotent by (app_id, name).
 */
export async function defineCollection(
  input: DefineCollectionInput
): Promise<DefineCollectionResult> {
  assertCollectionName(input.name);
  if (!isAccessMode(input.accessMode)) {
    throw new DataError(
      'invalid_request',
      'accessMode must be one of public-read, public-write, locked, owner-only'
    );
  }
  // Throws invalid_schema if the schema does not compile.
  compileSchema(input.jsonSchema);

  const db = getDb();
  const existing = await db
    .select({ id: collections.id })
    .from(collections)
    .where(
      and(eq(collections.appId, input.appId), eq(collections.name, input.name))
    )
    .limit(1);

  if (existing[0]) {
    await db
      .update(collections)
      .set({
        jsonSchema: input.jsonSchema,
        accessMode: input.accessMode,
        updatedAt: new Date(),
      })
      .where(eq(collections.id, existing[0].id));
    return {
      id: existing[0].id,
      name: input.name,
      accessMode: input.accessMode,
      created: false,
    };
  }

  const [row] = await db
    .insert(collections)
    .values({
      appId: input.appId,
      name: input.name,
      jsonSchema: input.jsonSchema,
      accessMode: input.accessMode,
    })
    .returning({ id: collections.id });
  return {
    id: row.id,
    name: input.name,
    accessMode: input.accessMode,
    created: true,
  };
}

/** List collections for an app (dashboard/read-only). */
export async function listCollections(appId: string): Promise<
  { name: string; accessMode: AccessMode }[]
> {
  const rows = await getDb()
    .select({ name: collections.name, accessMode: collections.accessMode })
    .from(collections)
    .where(eq(collections.appId, appId))
    .orderBy(collections.name);
  return rows.map((r) => ({ ...r, accessMode: r.accessMode as AccessMode }));
}
