/**
 * `/__drobek/v1/data/…` on every app host (preview AND production hosts of an
 * app share its records):
 *
 *   GET    :collection              → { records, next_cursor }   (read; `owner` → the caller's own)
 *   POST   :collection              → 201 the record             (create)
 *   GET    :collection/export.csv   → text/csv attachment, streamed (admin)
 *   GET    :collection/:id          → the record                 (read)
 *   PATCH  :collection/:id          → the record (shallow merge) (update)
 *   DELETE :collection/:id          → { id, deleted: true }      (delete)
 *
 * A record is `{ _id, _owner, _created_at, _updated_at, …fields }`. The `_…`
 * fields are the server's: sent by a client they are dropped. `_owner` is the
 * signed-in creator (null for an anonymous create) and never changes; `owner`
 * rules compare it.
 *
 * A write, in order: the collection's rule → the schema → the per-app write
 * rate limit → the quota (records and bytes per app, exact under a per-app
 * lock) → stored. Every statement is scoped to this app (store.ts).
 */
import { Readable } from 'node:stream';
import { csvChunks, respond, z, type ModuleContext, type ModuleRouter } from '@drobek/modules';
import { decideRecord, listScope, type Op } from './access.js';
import { COLLECTION_NAME_RE, rulesOf, type CollectionConfig, type DataConfig } from './config.js';
import { DataError } from './errors.js';
import { dataQuotaFromLimits } from './quota.js';
import { csvLines, pageOf, requireCollection } from './records.js';
import { parseFilterParam } from './query-build.js';
import { validateDocument } from './schema-validate.js';
import { deleteRecord, insertRecord, loadRecord, patchRecord, toRecord } from './store.js';

type Ctx = ModuleContext<DataConfig>;

export const DEFAULT_WRITE_RATE_LIMIT = 120;
export const DEFAULT_WRITE_RATE_WINDOW_MS = 60_000;
/** A write body (the per-record limit DATA_MAX_DOC_BYTES decides the rest). */
const MAX_WRITE_BODY = 256 * 1024;
const RECORD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function collectionOf(ctx: Ctx, raw: string): { name: string; c: CollectionConfig } {
  if (!COLLECTION_NAME_RE.test(raw)) {
    throw new DataError('not_found', `"${raw}" is not a collection name (letters, digits, - and _; starting with a letter).`);
  }
  return { name: raw, c: requireCollection(ctx.config, raw) };
}

function recordId(raw: string): string {
  if (!RECORD_ID_RE.test(raw)) throw new DataError('not_found', 'No such record.');
  return raw;
}

const OP_TEXT: Record<Op, string> = { read: 'read', create: 'add', update: 'change', delete: 'delete' };

function deny(status: 401 | 403, op: Op, name: string, rule: string): never {
  if (status === 401) {
    throw new DataError('unauthorized', `Sign in to this app first: only signed-in users may ${OP_TEXT[op]} records of "${name}" (rule ${op}: "${rule}").`);
  }
  throw new DataError('forbidden', `You may not ${OP_TEXT[op]} this record of "${name}" (rule ${op}: "${rule}").`);
}

/** A client's fields: a JSON object without the server's `_…` keys. */
export function clientFields(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new DataError('invalid_request', 'A record is a JSON object, e.g. { "title": "Milk", "done": false }.');
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (!k.startsWith('_') && v !== undefined) out[k] = v;
  }
  return out;
}

async function writeAllowed(ctx: Ctx): Promise<void> {
  const limits = await ctx.limits();
  const max = limits.DATA_WRITE_RATE_LIMIT ?? DEFAULT_WRITE_RATE_LIMIT;
  const windowMs = limits.DATA_WRITE_RATE_WINDOW_MS ?? DEFAULT_WRITE_RATE_WINDOW_MS;
  const r = await ctx.rateLimit('writes', 'app', max, windowMs);
  if (!r.ok) {
    throw new DataError('rate_limited', `Too many data writes for this app (${max} per ${Math.round(windowMs / 1000)} s). Slow down and retry.`, {
      details: { limit: 'DATA_WRITE_RATE_LIMIT', value: max },
      headers: { 'Retry-After': String(r.retryAfterSec) },
    });
  }
}

const listQuery = z.object({
  filter: z.string().max(8192).optional(),
  sort: z.string().max(64).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  limit: z.string().max(6).optional(),
  cursor: z.string().max(2048).optional(),
});

const exportQuery = listQuery.pick({ filter: true, sort: true, dir: true });

export function registerRoutes(r: ModuleRouter<DataConfig>): void {
  r.get('/:collection', { query: listQuery }, async (req, ctx) => {
    const { name, c } = collectionOf(ctx, req.params.collection);
    const rule = rulesOf(c).read;
    const scope = listScope(rule, ctx.principal);
    if (!scope.ok) deny(scope.status, 'read', name, rule);
    const q = req.query;
    const page = await pageOf(ctx.db, ctx.app.id, name, c, { filter: parseFilterParam(q.filter), sort: q.sort, dir: q.dir, limit: q.limit, cursor: q.cursor }, {
      ownerId: scope.ownerId,
      maxLimit: 200,
    });
    return { records: page.records, next_cursor: page.next_cursor };
  });

  r.post('/:collection', { maxBodyBytes: MAX_WRITE_BODY }, async (req, ctx) => {
    const { name, c } = collectionOf(ctx, req.params.collection);
    const rule = rulesOf(c).create;
    const d = decideRecord('create', rule, ctx.principal, null);
    if (!d.ok) deny(d.status, 'create', name, rule);
    const doc = clientFields(req.body);
    if (c.schema) validateDocument(c.schema, doc);
    await writeAllowed(ctx);
    const row = await insertRecord(ctx.db, {
      appId: ctx.app.id,
      collection: name,
      ownerId: ctx.principal.kind === 'user' ? ctx.principal.id : null,
      doc,
      limits: dataQuotaFromLimits(await ctx.limits()),
    });
    return respond(201, toRecord(row));
  });

  // Before `:collection/:id` — the first matching route wins.
  // Streamed (NSO-323 M5): one keyset page and one ~64 KiB chunk in memory,
  // never the whole file. The header is pulled BEFORE the 200, so a bad
  // filter / sort still answers a clean 400; the audit (with the row count)
  // is written when the stream ends — `complete: false` when it was cut off.
  r.get('/:collection/export.csv', { rule: 'admin', query: exportQuery }, async (req, ctx) => {
    const { name, c } = collectionOf(ctx, req.params.collection);
    const lines = csvLines(ctx.db, ctx.app.id, name, c, { filter: parseFilterParam(req.query.filter), sort: req.query.sort, dir: req.query.dir });
    const header = await lines.next();
    async function* body(): AsyncGenerator<string> {
      let rows = 0;
      let complete = false;
      try {
        if (!header.done) yield header.value;
        for (let line = await lines.next(); !line.done; line = await lines.next()) {
          rows += 1;
          yield line.value;
        }
        complete = true;
      } finally {
        await lines.return(undefined);
        await ctx.audit('export', complete ? { collection: name, rows } : { collection: name, rows, complete: false }).catch(() => undefined);
      }
    }
    return respond(200, Readable.from(csvChunks(body())), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}.csv"`,
    });
  });

  /** Load `:id` for `op`: 401 before the lookup for a visitor the rule can never admit, 404, then the rule with the stored owner. */
  async function target(ctx: Ctx, rawCollection: string, rawId: string, op: Op) {
    const { name, c } = collectionOf(ctx, rawCollection);
    const rule = rulesOf(c)[op];
    const pre = decideRecord(op, rule, ctx.principal, null);
    if (!pre.ok && pre.status === 401) deny(401, op, name, rule);
    const row = await loadRecord(ctx.db, ctx.app.id, name, recordId(rawId));
    if (!row) throw new DataError('not_found', `No record "${rawId}" in "${name}".`);
    const d = decideRecord(op, rule, ctx.principal, row.ownerId);
    if (!d.ok) deny(d.status, op, name, rule);
    return { name, c, row };
  }

  r.get('/:collection/:id', async (req, ctx) => {
    const { row } = await target(ctx, req.params.collection, req.params.id, 'read');
    return toRecord(row);
  });

  r.patch('/:collection/:id', { maxBodyBytes: MAX_WRITE_BODY }, async (req, ctx) => {
    const { name, c, row } = await target(ctx, req.params.collection, req.params.id, 'update');
    const fields = clientFields(req.body);
    const merged = (current: Record<string, unknown>) => {
      const doc = { ...current, ...fields };
      for (const k of Object.keys(doc)) if (k.startsWith('_')) delete doc[k];
      if (c.schema) validateDocument(c.schema, doc);
      return doc;
    };
    merged(row.doc ?? {}); // fail fast (422) before the write counts
    await writeAllowed(ctx);
    // Merged again onto the row as it is INSIDE the write lock — never the copy read above (NSO-322 M1).
    const updated = await patchRecord(ctx.db, { appId: ctx.app.id, collection: name, id: row.id, limits: dataQuotaFromLimits(await ctx.limits()), next: merged });
    if (!updated) throw new DataError('not_found', `No record "${row.id}" in "${name}".`);
    return toRecord(updated);
  });

  r.delete('/:collection/:id', async (req, ctx) => {
    const { name, row } = await target(ctx, req.params.collection, req.params.id, 'delete');
    await writeAllowed(ctx);
    await deleteRecord(ctx.db, ctx.app.id, name, row.id);
    return { id: row.id, deleted: true };
  });
}
