/**
 * drobek-module-hello — the example platform module (docs/MODULES.md).
 *
 *   DROBEK_MODULES=hello   → this package (`drobek-module-<name>`), resolved
 *                            from the drobek server's dependencies.
 *
 *   GET  /__drobek/v1/hello        → { greeting, message, waves, signed }
 *   POST /__drobek/v1/hello/wave   → { waves }   (rate-limited per visitor IP)
 *   GET  /__drobek/v1/hello/whoami → the visitor as ctx.principal (auth module)
 *   drobek.hello.ping() / drobek.hello.wave(name) / drobek.hello.whoami()
 *   config { greeting, excited } — a greeting change needs the owner's OK.
 */
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { count, eq } from 'drizzle-orm';
import { defineModule, z, type ModuleContext } from '@drobek/modules';
import { helloWaves } from './schema.js';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** The SDK entry next to this file: dist/sdk.js when built, src/sdk.ts in a source checkout. */
const sdkEntry = existsSync(here('./sdk.js')) ? here('./sdk.js') : here('./sdk.ts');

export const helloConfig = z.object({
  greeting: z.string().trim().min(1).max(80),
  excited: z.boolean(),
});
export type HelloConfig = z.infer<typeof helloConfig>;

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
}
`;

async function waveCount(db: ModuleContext['db'], appId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(helloWaves).where(eq(helloWaves.appId, appId));
  return Number(row?.n ?? 0);
}

const hello = defineModule<HelloConfig>({
  name: 'hello',
  version: '1.0.0',
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
