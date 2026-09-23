/**
 * Test modules: `echo` (every contract feature: confirmRequired, a required
 * secret, a limit, routes, SDK) and `quiet` (the bare minimum).
 */
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { defineModule, respond } from '../contract.js';
import { ModuleError } from '../errors.js';

export const echoConfig = z.object({
  greeting: z.string().min(1).max(40),
  access: z.enum(['public', 'user']),
  notify: z.array(z.string().email()).max(5),
  loud: z.boolean(),
});
export type EchoConfig = z.infer<typeof echoConfig>;

export const echo = defineModule<EchoConfig>({
  name: 'echo',
  version: '1.2.3',
  skill: { useWhen: 'you need to echo things back in a test', markdown: '# echo\n\nEchoes.\n' },
  configSchema: echoConfig,
  configDefaults: { greeting: 'hi', access: 'user', notify: [], loud: false },
  confirmRequired(before, after) {
    const out: string[] = [];
    if (before.access !== after.access && after.access === 'public') out.push('access: anyone can read');
    for (const a of after.notify) if (!before.notify.includes(a)) out.push(`notify: new recipient ${a}`);
    return out;
  },
  secrets: [
    { name: 'ECHO_TOKEN', description: 'upstream token', required: true },
    { name: 'ECHO_EXTRA', description: 'optional' },
  ],
  limits: [{ env: 'ECHO_PER_MINUTE', default: 5, meaning: 'echo calls per minute' }],
  routes(r) {
    r.get('/', { rule: (c) => c.access }, async (_req, ctx) => ({
      greeting: ctx.config.greeting,
      principal: ctx.principal.kind,
      hasToken: (await ctx.secrets.get('ECHO_TOKEN')) !== null,
    }));
    r.post(
      '/say',
      {
        rule: 'public',
        body: z.object({ text: z.string().min(1), n: z.number().int().optional() }),
        rateLimit: { bucket: 'say', max: 'ECHO_PER_MINUTE', windowMs: 60_000 },
      },
      async (req, ctx) => {
        await ctx.audit('said', { length: req.body.text.length });
        return { said: req.body.text, loud: ctx.config.loud };
      }
    );
    r.get('/items/:id', { rule: 'public' }, (req) => ({ id: req.params.id }));
    r.delete('/items/:id', { rule: 'public', csrf: 'same-origin' }, () => respond(204));
    r.get('/boom', { rule: 'public' }, () => {
      throw new Error('kaboom with internals');
    });
    r.get('/teapot', { rule: 'public' }, () => {
      throw new ModuleError('forbidden', 'no tea', { hint: "skill_info('tea')" });
    });
  },
  sdk: {
    entry: fileURLToPath(new URL('./fixture-sdk.ts', import.meta.url)),
    types: 'export interface Api { hi(): Promise<{ greeting: string }>; }',
  },
});

export const quiet = defineModule<{ on: boolean }>({
  name: 'quiet',
  version: '0.1.0',
  skill: { useWhen: 'you want nothing to happen', markdown: '# quiet\n' },
  configSchema: z.object({ on: z.boolean() }),
  configDefaults: { on: false },
});
