# drobek-module-acme-crm

The example EXTERNAL [drobek](https://github.com/freema/drobek) platform
module: generated with `create-drobek-module acme-crm` and extended, never a
dependency of the drobek server. It reaches a server only by installation
into `DROBEK_MODULES_DIR`, the way a third-party module does. The e2e flows
(`task e2e`, `task e2e:image`) pack and install it.

- `GET /__drobek/v1/acmecrm/` and `POST /__drobek/v1/acmecrm/` (rule
  `user`): the app's contacts, `drobek.acmecrm.list()` / `add(contact)`;
  an address the app has already answers the module's own error
  `crm_duplicate`.
- `availability: 'opt-in'`: a super-admin turns it on per workspace
  (or the limits provider's `MODULE_ENABLED_ACMECRM`).
- `contributes: { 'auth.signedIn': … }`: every sign-in to an app where it is
  on becomes a contact (source `sign-in`).
- Config `{ tags, fields }`, the limit `ACMECRM_CONTACTS_PER_APP`, the
  secret `ACMECRM_API_KEY`, the table `mod_acmecrm_contacts` (journal
  `__drizzle_migrations_mod_acmecrm`), and `SKILL.md`, checked by
  `checkSkill`.

## Develop

```sh
npm test            # routes through the production pipeline (PGlite) + the SKILL.md gate
npm run check       # the SKILL.md gate alone (checkSkill)
npm run typecheck
npm run build       # dist/ — what a drobek server loads
```

In the drobek repository it links the workspace `@drobek/modules`
(`pnpm --filter drobek-module-acme-crm test`); a module of your own gets it
from npm, as the scaffold writes it.

## Install on a drobek server

```sh
pnpm --filter drobek-module-acme-crm pack --pack-destination /tmp
task selfhost:module:add -- /tmp/drobek-module-acme-crm-0.1.0.tgz   # the dev stack: task module:add -- …
```

then add `drobek-module-acme-crm` to `DROBEK_MODULES` (the package name: a
module name has no dash, so the short form does not apply) and restart
drobek. The guide:
[docs/MODULES.md → Writing a module](https://github.com/freema/drobek/blob/main/docs/MODULES.md#writing-a-module).
