/**
 * drobek-module-hello — the example platform module (docs/MODULES.md).
 *
 *   DROBEK_MODULES=hello   → this package (`drobek-module-<name>`), resolved
 *                            from the drobek server's dependencies.
 *
 *   GET  /__drobek/v1/hello        → { greeting, message, waves, signed }
 *   POST /__drobek/v1/hello/wave   → { waves }   (rate-limited per visitor IP)
 *   GET  /__drobek/v1/hello/whoami → the visitor as ctx.principal (auth module)
 *   GET  /__drobek/v1/hello/greet  → { text, greeter } (?name=…&greeter=<id>)
 *   drobek.hello.ping() / wave(name) / whoami() / greet(name, greeter?)
 *   config { greeting, excited } — a greeting change needs the owner's OK.
 *
 * Module contract 1.1: the slot `hello.greeter` — other modules contribute
 * greeters (`contributes: { 'hello.greeter': { id, greet(name) } }`), the
 * greet route reads them with `ctx.contributions()` — and its own error code
 * `unknown_greeter` (`errors`).
 */
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { count, eq } from 'drizzle-orm';
import { ModuleError, defineModule, z, type ModuleContext } from '@drobek/modules';
import { helloWaves } from './schema.js';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** The SDK entry next to this file: dist/sdk.js when built, src/sdk.ts in a source checkout. */
const sdkEntry = existsSync(here('./sdk.js')) ? here('./sdk.js') : here('./sdk.ts');

export const helloConfig = z.object({
  greeting: z.string().trim().min(1).max(80),
  excited: z.boolean(),
});
export type HelloConfig = z.infer<typeof helloConfig>;

/** A contribution to the slot `hello.greeter`: another way to greet someone. */
export const greeterSchema = z.object({
  /** How an app picks it: `drobek.hello.greet(name, id)`. */
  id: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
  /** The greeting text for `name`. */
  greet: z.custom<(name: string) => string>((v) => typeof v === 'function', 'greet must be a function (name) => string'),
});
export type Greeter = z.infer<typeof greeterSchema>;

const SDK_TYPES = `
export interface Hello {
  greeting: string;
  /** greeting + "!" when excited, else greeting + "." */
  message: string;
  waves: number;
  /** true when the owner set the HELLO_SIGNATURE secret */
  signed: boolean;
  signature?: string;
}
export type Visitor = { signed_in: false } | { signed_in: true; id: string; email: string; role: 'user' | 'admin' };
export interface Api {
  ping(): Promise<Hello>;
  /** The visitor as every platform module sees them (signed in through the auth module, or not). */
  whoami(): Promise<Visitor>;
  /** name: 1–40 characters; rate-limited (HELLO_WAVES_PER_MINUTE per visitor per minute) */
  wave(name: string): Promise<{ waves: number }>;
  /** Greet \`name\` (1–40 characters) with the configured greeting, or with a greeter another module contributes (its id). */
  greet(name: string, greeter?: string): Promise<{ text: string; greeter: string | null }>;
}
`;

async function waveCount(db: ModuleContext['db'], appId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(helloWaves).where(eq(helloWaves.appId, appId));
  return Number(row?.n ?? 0);
}

const hello = defineModule<HelloConfig>({
  name: 'hello',
  version: '1.0.0',
  contract: '^1.1',
  skill: {
    useWhen: 'you want to check that platform modules work (a greeting from the server and a wave counter)',
    markdown: readFileSync(here('../SKILL.md'), 'utf8'),
  },
  configSchema: helloConfig,
  configDefaults: { greeting: 'Hello', excited: false },
  confirmRequired(before, after) {
    return before.greeting === after.greeting ? [] : [`greeting: "${before.greeting}" → "${after.greeting}"`];
  },
  secrets: [{ name: 'HELLO_SIGNATURE', description: 'HMAC key: ping() signs its message when set' }],
  rules: { ops: { ping: 'public', wave: 'public' } },
  limits: [{ env: 'HELLO_WAVES_PER_MINUTE', default: 30, meaning: 'waves one visitor IP may send per minute' }],
  slots: {
    'hello.greeter': {
      schema: greeterSchema,
      unique: 'id',
      description: 'Another way to greet: `greet(name)` returns the text `drobek.hello.greet(name, id)` answers.',
    },
  },
  errors: [
    {
      code: 'unknown_greeter',
      meaning: 'HTTP 404. No module on this server contributes a greeter with that id (`details.available` lists the ids there are).',
      fix: 'Call drobek.hello.greet(name) without a greeter, or pass one of `details.available`.',
    },
  ],
  routes(r) {
    r.get('/', { rule: 'public' }, async (_req, ctx) => {
      const message = ctx.config.greeting + (ctx.config.excited ? '!' : '.');
      const key = await ctx.secrets.get('HELLO_SIGNATURE');
      return {
        greeting: ctx.config.greeting,
        message,
        waves: await waveCount(ctx.db, ctx.app.id),
        signed: key !== null,
        ...(key !== null ? { signature: createHmac('sha256', key).update(message).digest('hex').slice(0, 16) } : {}),
      };
    });
    // ctx.principal: core's decision for this request (a signed-in end user
    // of THIS app, with their current role, or anonymous).
    r.get('/whoami', { rule: 'public' }, async (_req, ctx) =>
      ctx.principal.kind === 'user'
        ? { signed_in: true, id: ctx.principal.id, email: ctx.principal.email, role: ctx.principal.role }
        : { signed_in: false }
    );
    r.get(
      '/greet',
      { rule: 'public', query: z.object({ name: z.string().trim().min(1).max(40), greeter: z.string().optional() }) },
      (req, ctx) => {
        const id = req.query.greeter;
        if (id === undefined) return { text: `${ctx.config.greeting}, ${req.query.name}`, greeter: null };
        // The contributions of the active modules, in DROBEK_MODULES order.
        const greeters = ctx.contributions<Greeter>('hello.greeter');
        const greeter = greeters.find((g) => g.id === id);
        if (!greeter) {
          throw new ModuleError('unknown_greeter', `No greeter "${id}" on this server.`, {
            status: 404,
            details: { available: greeters.map((g) => g.id) },
          });
        }
        return { text: greeter.greet(req.query.name), greeter: greeter.id };
      }
    );
    r.post(
      '/wave',
      {
        rule: 'public',
        body: z.object({ name: z.string().trim().min(1).max(40) }),
        rateLimit: { bucket: 'wave', max: 'HELLO_WAVES_PER_MINUTE', windowMs: 60_000, per: 'ip' },
        maxBodyBytes: 1024,
      },
      async (req, ctx) => {
        await ctx.db.insert(helloWaves).values({ appId: ctx.app.id, name: req.body.name });
        return { waves: await waveCount(ctx.db, ctx.app.id) };
      }
    );
  },
  sdk: { entry: sdkEntry, types: SDK_TYPES },
  migrations: { folder: here('../migrations') },
});

export default hello;
