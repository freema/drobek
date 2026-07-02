import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type DB = PostgresJsDatabase<typeof schema>;

let sqlClient: ReturnType<typeof postgres> | null = null;
let db: DB | null = null;

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required');
  }
  return url;
}

/** Raw postgres.js client (lazy singleton). */
export function getSql(): ReturnType<typeof postgres> {
  if (!sqlClient) {
    sqlClient = postgres(requireDatabaseUrl(), {
      max: 10,
      connect_timeout: 5,
    });
  }
  return sqlClient;
}

/** Drizzle client over the shared postgres.js connection pool. */
export function getDb(): DB {
  if (!db) {
    db = drizzle(getSql(), { schema });
  }
  return db;
}

/** Cheap connectivity probe used by @drobek/core runHealthChecks(). */
export async function healthDbPing(): Promise<void> {
  await getSql()`select 1`;
}

/** Close the pool (tests / graceful shutdown). */
export async function closeDb(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
    sqlClient = null;
    db = null;
  }
}
