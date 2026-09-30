/**
 * drobek-module-legacyidp — a sign-in provider as it was written for
 * contract 1.1 before identities carried `issuer`: its `auth.provider`
 * contribution declares no `apiVersion` and `callback()` answers
 * `{ subject, email, emailVerified }`. A current server refuses it at start.
 */
import { defineAuthProvider, defineModule, z } from '@drobek/modules';

export default defineModule({
  name: 'legacyidp',
  version: '1.0.0',
  contract: '^1.1',
  skill: { useWhen: 'a test needs a provider written for auth provider API 1', markdown: '# legacyidp\n' },
  configSchema: z.object({}),
  configDefaults: {},
  requires: ['auth'],
  contributes: {
    'auth.provider': defineAuthProvider({
      id: 'legacyidp',
      label: 'Legacy IdP',
      configSchema: z.strictObject({ tenant: z.string().optional() }),
      async begin({ state }) {
        return { url: `https://idp.example/authorize?state=${encodeURIComponent(state)}` };
      },
      async callback() {
        return { subject: 'sub-1', email: 'ana@example.com', emailVerified: true };
      },
    }),
  },
});
