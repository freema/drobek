/**
 * drobek-module-guestbook — a test fixture for modules installed into
 * DROBEK_MODULES_DIR (NSO-345). Plain ESM without a build step, so a test (or
 * the EXT-09 e2e, after `npm pack`) can install it as it is.
 *
 *   GET  /__drobek/v1/guestbook        → { title, open, entries: [{ name, message, created_at }] }
 *   POST /__drobek/v1/guestbook/sign   → { entries }   ({ name, message }; rate-limited per visitor IP)
 *   drobek.guestbook.list() / sign(name, message)
 *   config { title, open, maxEntries } — closing the book (open: false) refuses sign with guestbook_closed.
 *   contributes the greeter "guestbook" to the slot `hello.greeter` (so the
 *   module `hello` must be active too).
 *
 * `@drobek/modules` and `drizzle-orm` are optional peers: the server hands
 * the module its own instances (host-provided peers).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { ModuleError, defineModule, z } from '@drobek/modules';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

const config = z.object({
  title: z.string().trim().min(1).max(80),
  open: z.boolean(),
  maxEntries: z.number().int().min(1).max(100),
});

const SDK_TYPES = `
export interface Entry { name: string; message: string; created_at: string }
export interface Api {
  /** The newest entries (config maxEntries), newest first. */
  list(): Promise<{ title: string; open: boolean; entries: Entry[] }>;
  /** name: 1–40, message: 1–280 characters; fails with guestbook_closed when the owner closed the book. */
  sign(name: string, message: string): Promise<{ entries: number }>;
}
`;

/** drizzle over postgres-js answers an array of rows, over PGlite `{ rows }`. */
const rowsOf = (res) => (Array.isArray(res) ? res : (res?.rows ?? []));

async function entryCount(db, appId) {
  const [row] = rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM mod_guestbook_entries WHERE app_id = ${appId}`));
  return Number(row?.n ?? 0);
}

export default defineModule({
  name: 'guestbook',
  version: '1.0.0',
  contract: '^1.1',
  skill: {
    useWhen: 'the app needs a guestbook: visitors leave a short signed message and everyone reads the newest ones',
    markdown: readFileSync(here('./SKILL.md'), 'utf8'),
  },
  configSchema: config,
  configDefaults: { title: 'Guestbook', open: true, maxEntries: 20 },
  rules: { ops: { list: 'public', sign: 'public' } },
  limits: [{ env: 'GUESTBOOK_SIGNS_PER_HOUR', default: 10, meaning: 'guestbook entries one visitor IP may add per hour' }],
  errors: [
    {
      code: 'guestbook_closed',
      meaning: 'HTTP 403. The app owner closed the guestbook (config open: false); reading still works.',
      fix: 'Show the entries without the sign form, or ask the owner to set open: true.',
    },
  ],
  contributes: {
    'hello.greeter': { id: 'guestbook', greet: (name) => `Welcome, ${name} — please sign the guestbook` },
  },
  routes(r) {
    r.get('/', { rule: 'public' }, async (_req, ctx) => {
      const rows = rowsOf(
        await ctx.db.execute(
          sql`SELECT name, message, created_at FROM mod_guestbook_entries WHERE app_id = ${ctx.app.id} ORDER BY id DESC LIMIT ${ctx.config.maxEntries}`
        )
      );
      return {
        title: ctx.config.title,
        open: ctx.config.open,
        entries: rows.map((e) => ({ name: e.name, message: e.message, created_at: new Date(e.created_at).toISOString() })),
      };
    });
    r.post(
      '/sign',
      {
        rule: 'public',
        body: z.object({ name: z.string().trim().min(1).max(40), message: z.string().trim().min(1).max(280) }),
        rateLimit: { bucket: 'sign', max: 'GUESTBOOK_SIGNS_PER_HOUR', windowMs: 3_600_000, per: 'ip' },
        maxBodyBytes: 2048,
      },
      async (req, ctx) => {
        if (!ctx.config.open) throw new ModuleError('guestbook_closed', 'This guestbook is closed.', { status: 403 });
        await ctx.db.execute(
          sql`INSERT INTO mod_guestbook_entries (app_id, name, message) VALUES (${ctx.app.id}, ${req.body.name}, ${req.body.message})`
        );
        return { entries: await entryCount(ctx.db, ctx.app.id) };
      }
    );
  },
  sdk: { entry: here('./sdk.js'), types: SDK_TYPES },
  migrations: { folder: here('./migrations') },
});

/** Test hooks: the ModuleError class and zod this file got (host-provided peers make them the server's). */
export const peersSeen = { ModuleError, z };
