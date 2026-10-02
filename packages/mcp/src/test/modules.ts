/**
 * The platform module the MCP tool tests configure: `greet` — a greeting
 * (changing it needs the owner's confirmation), an `audience` (opening it to
 * `public` needs confirmation) and a harmless `emoji` flag; one optional secret.
 */
import { ModuleError, defineModule, z } from '@drobek/modules';

export const greet = defineModule({
  name: 'greet',
  version: '1.0.0',
  skill: {
    useWhen: 'you want the server to greet the visitor',
    markdown: '# greet\n\nCall `drobek.greet.hi()`.\n',
  },
  configSchema: z.object({
    greeting: z.string().min(1).max(40),
    audience: z.enum(['user', 'public']),
    emoji: z.boolean(),
  }),
  configDefaults: { greeting: 'Hi', audience: 'user' as 'user' | 'public', emoji: false },
  confirmRequired(before, after) {
    const out: string[] = [];
    if (before.greeting !== after.greeting) out.push(`greeting: "${before.greeting}" → "${after.greeting}"`);
    if (before.audience !== after.audience && after.audience === 'public') out.push('audience: anyone may call greet');
    return out;
  },
  secrets: [{ name: 'GREET_KEY', description: 'signs greetings', required: true }],
});

/**
 * `store` — a records module (the query_data and data write tests):
 * collections declared in the config, records kept in memory per app id
 * (STORE_DATA). A record with a `bad` field fails validation; an app holds at
 * most STORE_MAX records; records of an undeclared collection are orphans.
 */
export const STORE_DATA = new Map<string, Record<string, Record<string, unknown>[]>>();

type StoreConfig = { collections: string[] };

export const STORE_MAX = 5;

function storeRecords(appId: string, collection: string): Record<string, unknown>[] {
  return STORE_DATA.get(appId)?.[collection] ?? [];
}

function storeApp(appId: string): Record<string, Record<string, unknown>[]> {
  let app = STORE_DATA.get(appId);
  if (!app) STORE_DATA.set(appId, (app = {}));
  return app;
}

function declared(config: StoreConfig, collection: string): void {
  if (!config.collections.includes(collection)) throw new ModuleError('not_found', `This app has no collection "${collection}".`);
}

function checked(fields: Record<string, unknown>, index?: number): Record<string, unknown> {
  if (!('bad' in fields)) return fields;
  const errors = [{ path: '/bad', message: 'is not allowed' }];
  throw new ModuleError('validation_failed', 'The record does not match the schema.', { details: index === undefined ? errors : { index, errors } });
}

let storeSeq = 0;

export const store = defineModule<StoreConfig>({
  name: 'store',
  version: '1.0.0',
  skill: { useWhen: 'the app stores records', markdown: '# store\n' },
  configSchema: z.object({ collections: z.array(z.string()) }),
  configDefaults: { collections: [] },
  records: {
    async collections(view) {
      return view.config.collections.map((name) => ({ name, rules: {}, schema: null, columns: [], records: storeRecords(view.app.id, name).length }));
    },
    async query(view, q) {
      if (!view.config.collections.includes(q.collection)) throw new ModuleError('not_found', `This app has no collection "${q.collection}".`);
      if (q.filter && typeof q.filter === 'object' && 'secret' in q.filter) throw new ModuleError('invalid_request', 'filter field "secret" is not allowed');
      const all = storeRecords(view.app.id, q.collection);
      const limit = q.limit ?? 50;
      return {
        collection: { name: q.collection, rules: {}, schema: null, columns: [], records: all.length },
        records: all.slice(0, limit),
        total: all.length,
        next_cursor: all.length > limit ? 'next' : null,
      };
    },
    async get(view, collection, id) {
      return storeRecords(view.app.id, collection).find((r) => r._id === id) ?? null;
    },
    async remove(view, collection, id) {
      const all = storeRecords(view.app.id, collection);
      const i = all.findIndex((r) => r._id === id);
      if (i < 0) return false;
      all.splice(i, 1);
      return true;
    },
    async *csv() {},
    async create(view, collection, records) {
      declared(view.config, collection);
      const docs = records.map((r, i) => checked(r, i));
      const held = Object.values(STORE_DATA.get(view.app.id) ?? {}).reduce((n, rows) => n + rows.length, 0);
      if (held + docs.length > STORE_MAX) {
        throw new ModuleError('quota_exceeded', `This app may store at most ${STORE_MAX} records.`, { details: { limit: 'STORE_MAX', value: STORE_MAX } });
      }
      const app = storeApp(view.app.id);
      const rows = docs.map((d) => ({ ...d, _id: `s${++storeSeq}`, _owner: null, _updated_at: new Date().toISOString() }));
      app[collection] = [...(app[collection] ?? []), ...rows];
      return rows;
    },
    async update(view, collection, id, fields, opts) {
      declared(view.config, collection);
      const all = storeRecords(view.app.id, collection);
      const i = all.findIndex((r) => r._id === id);
      if (i < 0) return null;
      const meta = { _id: all[i]._id, _owner: all[i]._owner, _updated_at: new Date().toISOString() };
      all[i] = { ...(opts?.merge ? all[i] : {}), ...checked(fields), ...meta };
      return all[i];
    },
    async dropCollection(view, collection) {
      declared(view.config, collection);
      const app = storeApp(view.app.id);
      const records = app[collection]?.length ?? 0;
      delete app[collection];
      return { records, configPatch: { collections: view.config.collections.filter((c) => c !== collection) } };
    },
    async orphans(view) {
      return Object.entries(STORE_DATA.get(view.app.id) ?? {})
        .filter(([name, rows]) => !view.config.collections.includes(name) && rows.length > 0)
        .map(([name, rows]) => ({ name, records: rows.length }));
    },
    async purgeOrphan(view, collection) {
      if (view.config.collections.includes(collection)) throw new ModuleError('conflict', `"${collection}" is declared.`);
      const app = storeApp(view.app.id);
      const records = app[collection]?.length ?? 0;
      delete app[collection];
      return { records };
    },
  },
});
