# {{package}}

A [drobek](https://github.com/freema/drobek) platform module: server routes
under `/__drobek/v1/{{module}}/…` on the app hosts, the browser SDK slice
`drobek.{{module}}`, a per-app config the agent sets with
`configure_module`, and a skill (`SKILL.md`) the agent reads with
`skill_info('{{module}}')`. Written against the module contract `^1.1`
(`@drobek/modules`).

## Develop

```sh
npm install
npm test            # routes through the production pipeline (PGlite) + the SKILL.md gate
npm run check       # the SKILL.md gate alone (checkSkill)
npm run typecheck
npm run build       # dist/ — what a drobek server loads
```

- `src/index.ts` — `defineModule(...)`: config, routes, limits, secrets,
  errors, the SDK types, the migrations folder.
- `src/sdk.ts` — the browser half, bundled into `/__drobek/sdk.js`.
- `src/schema.ts` + `migrations/` — the module's own tables (`mod_{{module}}_*`,
  journal `__drizzle_migrations_mod_{{module}}`). Add a migration as
  `migrations/0001_<name>.sql` + a journal entry.
- `SKILL.md` — five sections, at most 150 lines; every code block is
  compiled and typechecked by `npm run check`.

## Install on a drobek server

Publish the package (`npm publish`) or pack it (`npm pack` → a tarball the
server can download). Then, on the server:

```sh
task selfhost:module:add -- {{package}}@0.1.0     # or the URL of a packed tarball
```

and add the module to `DROBEK_MODULES` in `.env.production`:

```sh
DROBEK_MODULES=auth,email,forms,data,proxy,files,{{entry}}
```

Then restart drobek (see the self-hosting guide). The server refuses a module whose
`contract` range does not match its module contract version; `zod`,
`drizzle-orm` and `@drobek/modules` come from the server (they are peer
dependencies, never bundled).

A module runs inside the drobek process with the whole database: an
operator installs only modules they trust. The guide:
[docs/MODULES.md → Writing a module](https://github.com/freema/drobek/blob/main/docs/MODULES.md#writing-a-module).
