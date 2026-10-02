/**
 * The data write tools (MCP parity with the dashboard's Data tab):
 * create_records, update_record, delete_record, delete_collection and
 * purge_orphan_records. Every body asks the app's records authority (the
 * module that declares `records` — the built-in `data`) through the SAME
 * module-runtime binding as the dashboard, so the module's schema
 * validation, record size and quotas apply exactly as there. It is the
 * owner's view: the collection's end-user rules do not apply, records added
 * here have no `_owner`, and owner writes skip the app's write rate limit
 * (never a quota).
 *
 * editor+ like the dashboard's actions; a taken-down app refuses every one
 * (`app_locked_by_admin`); each change is audited with the agent as the
 * actor (collection, record ids and counts — never values). Deleting a
 * collection and purging orphan records cannot be undone: they need
 * `user_confirmed: true`, checked after everything else so the agent never
 * asks about a call that cannot happen. delete_collection also changes the
 * data config, so it takes the single-writer lease like configure_module.
 * The answers carry ids and counts, never record content (that stays
 * behind query_data's untrusted envelope).
 */
import { CREATE_RECORDS_MAX } from '@drobek/agent-dx';
import { AUDIT_ACTIONS, actorKindForSurface, writeAudit } from '@drobek/audit';
import { isModuleError, type BoundRecords } from '@drobek/modules';
import { authorizeApp } from './access.js';
import { ToolError, lockedByAdmin } from './errors.js';
import type { AppRow } from './queries.js';
import { takeLease, type CallContext } from './tools.js';

/** The app (editor+, not taken down) and its records store — or a ToolError. */
async function dataApp(ctx: CallContext, appId: string): Promise<{ app: AppRow; records: BoundRecords }> {
  const { app } = await authorizeApp(ctx.principal, appId, 'editor');
  if (app.lockedReason) throw lockedByAdmin(app.lockedReason);
  const records = await ctx.modules.records({ id: app.id, slug: app.slug, workspaceId: app.workspaceId });
  if (!records) {
    throw new ToolError('not_found', 'This server has no data module: apps here store no records.', { hint: 'skill_info()' });
  }
  return { app, records };
}

function collectionArg(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ToolError('invalid_params', '`collection` must be the name of a collection of the app (get_app shows the data config).');
  }
  return raw;
}

function idArg(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) {
    throw new ToolError('invalid_params', '`id` must be the `_id` of a record (query_data lists them).');
  }
  return raw;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `invalid_params.issues`: the field errors of a module `validation_failed` (`[{ path, message }]`). */
function issuesOf(details: unknown): unknown[] {
  if (Array.isArray(details)) return details;
  if (isObject(details) && Array.isArray(details.errors)) return details.errors;
  return [];
}

/**
 * A records-module error as the tool error the agent acts on: an unknown
 * collection → not_found with `available`; a record the schema refuses →
 * invalid_params with `issues` (+ `index` in a batch); a quota or the record
 * size → limit_exceeded with `limit` + `value`; a module that cannot do it →
 * unavailable. Anything else stays as it is (internal_error).
 */
async function toolError(records: BoundRecords, err: unknown): Promise<unknown> {
  if (!isModuleError(err)) return err;
  const hint = { hint: `skill_info('${records.module}')` };
  const details = isObject(err.details) ? err.details : {};
  switch (err.code) {
    case 'not_found':
      return new ToolError('not_found', err.message, { available: (await records.collections()).map((c) => c.name), ...hint });
    case 'validation_failed':
      return new ToolError('invalid_params', err.message, {
        ...(typeof details.index === 'number' ? { index: details.index } : {}),
        issues: issuesOf(err.details),
        ...hint,
      });
    case 'invalid_request':
    case 'invalid_schema':
    case 'conflict':
      return new ToolError('invalid_params', err.message, hint);
    case 'quota_exceeded':
    case 'limit_exceeded':
    case 'payload_too_large':
      return new ToolError('limit_exceeded', err.message, {
        ...(typeof details.limit === 'string' ? { limit: details.limit } : {}),
        ...(typeof details.value === 'number' ? { value: details.value } : {}),
        ...hint,
      });
    case 'unavailable':
      return new ToolError('unavailable', err.message, hint);
    default:
      return err;
  }
}

async function call<T>(records: BoundRecords, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw await toolError(records, err);
  }
}

async function audit(ctx: CallContext, app: AppRow, action: string, meta: Record<string, unknown>): Promise<void> {
  await writeAudit({
    workspaceId: app.workspaceId,
    actorUserId: ctx.principal.userId,
    actorKind: actorKindForSurface('mcp'),
    action,
    subjectType: 'app',
    target: app.slug,
    meta,
  });
}

function noRecord(collection: string, id: string): ToolError {
  return new ToolError('not_found', `No record "${id}" in "${collection}".`, { hint: 'query_data lists the records of a collection with their _id.' });
}

// ── create_records ───────────────────────────────────────────────────────────

export async function createRecordsTool(ctx: CallContext, args: { app_id: string; collection: string; records: unknown }) {
  const { app, records } = await dataApp(ctx, args.app_id);
  const collection = collectionArg(args.collection);
  const batch = args.records;
  if (!Array.isArray(batch) || batch.length === 0 || batch.length > CREATE_RECORDS_MAX) {
    throw new ToolError(
      'invalid_params',
      `\`records\` must be 1–${CREATE_RECORDS_MAX} JSON objects. Split a bigger batch into several calls — each call is stored all or nothing.`,
      { limit: CREATE_RECORDS_MAX }
    );
  }
  const bad = batch.findIndex((r) => !isObject(r));
  if (bad >= 0) throw new ToolError('invalid_params', `Record ${bad} is not a JSON object. Nothing was stored.`, { index: bad });
  const stored = await call(records, () => records.create(collection, batch as Record<string, unknown>[]));
  await audit(ctx, app, AUDIT_ACTIONS.dataRecordCreate, { module: records.module, collection, records: stored.length });
  return {
    app_id: app.id,
    collection,
    created: stored.length,
    ids: stored.map((r) => String(r._id)),
    note: `${stored.length === 1 ? 'The record is' : `All ${stored.length} records are`} stored (no _owner). The app reads them under the collection's rules; query_data shows them as the owner sees them.`,
  };
}

// ── update_record ────────────────────────────────────────────────────────────

export async function updateRecordTool(
  ctx: CallContext,
  args: { app_id: string; collection: string; id: string; fields: unknown; replace?: boolean }
) {
  const { app, records } = await dataApp(ctx, args.app_id);
  const collection = collectionArg(args.collection);
  const id = idArg(args.id);
  if (!isObject(args.fields)) throw new ToolError('invalid_params', '`fields` must be a JSON object, e.g. { "done": true }.');
  const replace = args.replace === true;
  const updated = await call(records, () => records.update(collection, id, args.fields as Record<string, unknown>, { merge: !replace }));
  if (!updated) throw noRecord(collection, id);
  await audit(ctx, app, AUDIT_ACTIONS.dataRecordUpdate, { module: records.module, collection, id });
  return {
    app_id: app.id,
    collection,
    id,
    replaced: replace,
    updated_at: String(updated._updated_at),
    note: replace
      ? "The record's own fields are exactly the ones you sent now; _owner and _created_at stayed."
      : 'The fields you sent are merged onto the record; its other fields, _owner and _created_at stayed.',
  };
}

// ── delete_record ────────────────────────────────────────────────────────────

export async function deleteRecordTool(ctx: CallContext, args: { app_id: string; collection: string; id: string }) {
  const { app, records } = await dataApp(ctx, args.app_id);
  const collection = collectionArg(args.collection);
  const id = idArg(args.id);
  const removed = await call(records, () => records.remove(collection, id));
  if (!removed) throw noRecord(collection, id);
  await audit(ctx, app, AUDIT_ACTIONS.dataRecordDelete, { module: records.module, collection, id });
  return { app_id: app.id, collection, id, deleted: true };
}

// ── delete_collection ────────────────────────────────────────────────────────

export async function deleteCollectionTool(ctx: CallContext, args: { app_id: string; collection: string; user_confirmed?: boolean }) {
  const { app, records } = await dataApp(ctx, args.app_id);
  const collection = collectionArg(args.collection);
  const declared = await records.collections();
  const meta = declared.find((c) => c.name === collection);
  if (!meta) {
    throw new ToolError('not_found', `This app has no collection "${collection}".`, {
      available: declared.map((c) => c.name),
      hint: `skill_info('${records.module}')`,
    });
  }
  if (args.user_confirmed !== true) {
    const name = app.name ?? app.slug;
    const held = meta.records === 1 ? '1 record' : `${meta.records} records`;
    throw new ToolError(
      'user_confirmation_required',
      `Deleting the collection "${collection}" of "${name}" deletes its ${held} for good and removes it from the data config (its rules and schema): the app's calls to it answer 404 afterwards. Ask the user whether to delete "${collection}" with its ${held}, and call again with user_confirmed: true only after they say yes.`,
      { collection, records: meta.records }
    );
  }
  await takeLease(ctx, app.id);
  const out = await call(records, () => records.dropCollection(collection, ctx.principal.userId, 'mcp'));
  return {
    app_id: app.id,
    collection,
    deleted_records: out.records,
    note: `"${collection}" and its records are gone. Remove the app's code that still uses it (write_files) — those calls answer 404 now.`,
  };
}

// ── purge_orphan_records ─────────────────────────────────────────────────────

export async function purgeOrphanRecordsTool(ctx: CallContext, args: { app_id: string; collection?: string; user_confirmed?: boolean }) {
  const { app, records } = await dataApp(ctx, args.app_id);
  const orphans = await records.orphans();
  let targets = orphans;
  if (args.collection !== undefined) {
    const collection = collectionArg(args.collection);
    if ((await records.collections()).some((c) => c.name === collection)) {
      throw new ToolError('invalid_params', `"${collection}" is a declared collection, not an orphan: delete it with delete_collection.`, { orphans });
    }
    targets = orphans.filter((o) => o.name === collection);
    if (targets.length === 0) throw new ToolError('not_found', `"${collection}" holds no orphan records.`, { orphans });
  }
  if (targets.length === 0) {
    return { app_id: app.id, purged: [], note: 'This app has no orphan records: nothing to purge.' };
  }
  if (args.user_confirmed !== true) {
    const list = targets.map((o) => `"${o.name}" (${o.records === 1 ? '1 record' : `${o.records} records`})`).join(', ');
    throw new ToolError(
      'user_confirmation_required',
      `Orphan records belong to collections the data config no longer declares: no view shows them, yet they count towards the app's quotas. Purging deletes them for good: ${list}. Ask the user whether to purge them, and call again with user_confirmed: true only after they say yes.`,
      { orphans: targets }
    );
  }
  const purged: { name: string; records: number }[] = [];
  for (const o of targets) {
    const out = await call(records, () => records.purgeOrphan(o.name, ctx.principal.userId, 'mcp'));
    purged.push({ name: o.name, records: out.records });
  }
  return { app_id: app.id, purged, note: 'The orphan records are deleted; they no longer count towards the app\'s quotas.' };
}
