/**
 * Assignment ↔ upstream RECORD binding (NSO-326). The app config names an
 * upstream by NAME (what the agent writes and the dashboard shows); drobek
 * stores the id of the upstream record a workspace admin confirmed next to it
 * (`upstreams.<name>.id`). A deleted and re-registered upstream is a new record
 * with a new id, so the old assignment no longer matches and the app must be
 * confirmed again.
 *
 * The id is written by drobek, not through configure_module: in the confirm
 * transaction (onConfirmed) and — for configs from before the binding (the
 * name only) — lazily by the first call that finds the app on the current
 * record's allow-list (proof that an admin confirmed THAT record). No
 * migration: the stored JSON gains the key when it is first needed.
 */
import { and, eq, sql } from 'drizzle-orm';
import { moduleConfigs, type DB } from '@drobek/db';

const MODULE = 'proxy';

/**
 * Store `upstreamId` as the binding of the assignment `name` in the app's
 * stored proxy config. Only an existing assignment is touched (a removed one
 * is never re-created); with `onlyIfUnbound`, only one without an id yet.
 * Returns whether a row changed.
 */
export async function bindAssignment(
  db: DB,
  appId: string,
  name: string,
  upstreamId: string,
  opts: { onlyIfUnbound?: boolean } = {}
): Promise<boolean> {
  const entry = sql`(${moduleConfigs.config} -> 'upstreams' -> ${name}::text)`;
  const rows = await db
    .update(moduleConfigs)
    .set({
      config: sql`jsonb_set(${moduleConfigs.config}, ARRAY['upstreams', ${name}::text, 'id']::text[], to_jsonb(${upstreamId}::text), true)`,
    })
    .where(
      and(
        eq(moduleConfigs.appId, appId),
        eq(moduleConfigs.module, MODULE),
        sql`jsonb_typeof(${entry}) = 'object'`,
        opts.onlyIfUnbound ? sql`(${entry} -> 'id') IS NULL` : undefined
      )
    )
    .returning({ appId: moduleConfigs.appId });
  return rows.length > 0;
}
