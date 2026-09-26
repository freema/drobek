/**
 * {{package}} — a drobek platform module (module contract ^1.1).
 *
 *   DROBEK_MODULES=…,{{entry}}
 *
 *   GET  /__drobek/v1/{{module}}/items → { items, upstream }   (newest first, at most 100)
 *   POST /__drobek/v1/{{module}}/items → the new item           ({ title }, rate-limited per visitor IP)
 *   drobek.{{module}}.list() / add(title)
 *   config { write, maxItems } — opening `write` to everyone needs the owner's OK.
 *
 * docs/MODULES.md in the drobek repository is the contract; SKILL.md is what
 * the agent reads (`skill_info('{{module}}')`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { count, desc, eq } from 'drizzle-orm';
import { ModuleError, defineModule, z, type ModuleContext } from '@drobek/modules';
import { items } from './schema.js';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** The SDK entry next to this file: dist/sdk.js when built, src/sdk.ts in a source checkout. */
const sdkEntry = existsSync(here('./sdk.js')) ? here('./sdk.js') : here('./sdk.ts');

export const config = z.object({
  /** Who may add items: anyone, or end users signed in through the auth module. */
  write: z.enum(['public', 'user']),
  /** The most items one app keeps. */
  maxItems: z.number().int().min(1).max(100_000),
});
export type Config = z.infer<typeof config>;

/** What `drobek.{{module}}` looks like to the app (sdk.d.ts); src/sdk.ts implements it. */
const SDK_TYPES = `
export interface Item {
  id: number;
  title: string;
  created_at: string;
}
export interface Api {
  /** The app's items, newest first (at most 100); upstream: the owner set {{MODULE}}_API_KEY */
  list(): Promise<{ items: Item[]; upstream: boolean }>;
  /** title: 1–200 characters; rate-limited ({{MODULE}}_ADDS_PER_MINUTE per visitor IP per minute) */
  add(title: string): Promise<Item>;
}
`;

const itemView = (row: typeof items.$inferSelect) => ({ id: row.id, title: row.title, created_at: row.createdAt.toISOString() });

async function itemCount(db: ModuleContext['db'], appId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(items).where(eq(items.appId, appId));
  return Number(row?.n ?? 0);
}

export default defineModule<Config>({
  name: '{{module}}',
  version: '0.1.0',
  contract: '^1.1',
  skill: {
    useWhen: 'the app keeps a list of items on the server (the {{module}} module)',
    markdown: readFileSync(here('../SKILL.md'), 'utf8'),
  },
  configSchema: config,
  configDefaults: { write: 'public', maxItems: 1000 },
  // A change that widens who can write waits for the app owner's confirmation.
  confirmRequired(before, after) {
    return before.write !== after.write && after.write === 'public' ? ['write: anyone may add items'] : [];
  },
  // Names only: the owner sets the value in the dashboard; ctx.secrets.get reads it.
  secrets: [{ name: '{{MODULE}}_API_KEY', description: 'The key of the upstream API this module calls (optional)' }],
  // The operator (or the limits provider, per workspace) may change the default.
  limits: [{ env: '{{MODULE}}_ADDS_PER_MINUTE', default: 30, meaning: 'items one visitor IP may add per minute' }],
  // Every code a route throws besides the core ones (a ModuleError with another code is a 500).
  errors: [
    {
      code: '{{module}}_full',
      meaning: 'HTTP 409. The app already keeps `maxItems` items (`details.max`).',
      fix: 'Tell the user the list is full; the app owner can raise maxItems with configure_module.',
    },
  ],
  routes(r) {
    r.get('/items', { rule: 'public' }, async (_req, ctx) => {
      const rows = await ctx.db.select().from(items).where(eq(items.appId, ctx.app.id)).orderBy(desc(items.id)).limit(100);
      // Call your upstream with the key here; the value never leaves the server.
      const key = await ctx.secrets.get('{{MODULE}}_API_KEY');
      return { items: rows.map(itemView), upstream: key !== null };
    });
    r.post(
      '/items',
      {
        rule: (c) => c.write,
        body: z.object({ title: z.string().trim().min(1).max(200) }),
        rateLimit: { bucket: 'add', max: '{{MODULE}}_ADDS_PER_MINUTE', windowMs: 60_000, per: 'ip' },
        maxBodyBytes: 4096,
      },
      async (req, ctx) => {
        if ((await itemCount(ctx.db, ctx.app.id)) >= ctx.config.maxItems) {
          throw new ModuleError('{{module}}_full', `This app keeps at most ${ctx.config.maxItems} items.`, {
            status: 409,
            details: { max: ctx.config.maxItems },
          });
        }
        const [row] = await ctx.db.insert(items).values({ appId: ctx.app.id, title: req.body.title }).returning();
        await ctx.audit('add', { id: row.id });
        return itemView(row);
      }
    );
  },
  sdk: { entry: sdkEntry, types: SDK_TYPES },
  migrations: { folder: here('../migrations') },
});
