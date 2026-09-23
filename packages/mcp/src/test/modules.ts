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
 * `store` — a records module (the query_data tests): collections declared in
 * the config, records kept in memory per app id (STORE_DATA).
 */
export const STORE_DATA = new Map<string, Record<string, Record<string, unknown>[]>>();

type StoreConfig = { collections: string[] };

function storeRecords(appId: string, collection: string): Record<string, unknown>[] {
  return STORE_DATA.get(appId)?.[collection] ?? [];
}

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
    async remove() {
      return false;
    },
    async *csv() {},
  },
});
