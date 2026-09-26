# @drobek/modules

The platform module contract of [drobek](https://github.com/freema/drobek) —
the cloud workspace where an agent builds, previews and publishes web apps.
A platform module is the server half of an app backend: routes under
`/__drobek/v1/<module>/…`, a slice of the browser SDK (`drobek.<module>`),
a per-app config the agent sets with `configure_module` and a skill the
agent reads with `skill_info`.

```ts
import { defineModule, z } from '@drobek/modules';

export default defineModule({
  name: 'erp',
  version: '1.0.0',
  contract: '^1.1',
  skill: { useWhen: 'the app reads orders from the company ERP', markdown: '# erp — …' },
  configSchema: z.object({}),
  configDefaults: {},
  routes(r) {
    r.get('/', { rule: 'public' }, () => ({ ok: true }));
  },
});
```

- `@drobek/modules` — `defineModule`, `z`, `respond`, `ModuleError` and the
  types a module needs (`ModuleContext`, `DB`, `Logger`, `SdkCore`, …).
- `@drobek/modules/testing` — `createModuleTestContext` (a route through
  the production pipeline, without a server), `coreMigrationsDir` +
  `createTestApp` (a PGlite database with the core schema) and
  `checkSkill` (the SKILL.md gate the built-in modules pass).

Start a module with `npm create drobek-module@latest <name>`. The guide —
contract, testing, publishing, installing on a server — is
[Writing a module](https://github.com/freema/drobek/blob/main/docs/MODULES.md#writing-a-module).

`zod` and `drizzle-orm` are peer dependencies: on a drobek server an
external module uses the server's own instances. Licence: AGPL-3.0-only.
