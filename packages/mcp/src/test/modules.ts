/**
 * The platform module the MCP tool tests configure: `greet` — a greeting
 * (changing it needs the owner's confirmation), an `audience` (opening it to
 * `public` needs confirmation) and a harmless `emoji` flag; one optional secret.
 */
import { defineModule, z } from '@drobek/modules';

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
