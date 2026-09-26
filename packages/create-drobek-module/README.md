# create-drobek-module

Scaffold a [drobek](https://github.com/freema/drobek) platform module:

```sh
npm create drobek-module@latest erp
# → drobek-module-erp/ — the module "erp"
npm create drobek-module@latest @acme/drobek-module-erp
npm create drobek-module@latest acme-erp -- --module acmeerp
```

Options: `--module <name>` (the module name, `^[a-z][a-z0-9]{1,30}$`;
default: the package name without `drobek-module-` and dashes), `--dir
<parent>`, `--force` (write into a non-empty directory).

The output is a working module against the module contract `^1.1`:

- `src/index.ts` — `defineModule` with `contract`, config + an owner
  confirmation, a secret, a limit, an own error code and a GET/POST route
  pair over the module's table;
- `src/sdk.ts` — the browser half (`drobek.<name>.list()` / `add(title)`);
- `src/schema.ts` + `migrations/0000_init.sql` — the table `mod_<name>_items`;
- `SKILL.md` — the five-section skill an agent reads with `skill_info`;
- `src/index.test.ts` — the routes through the production pipeline
  (`createModuleTestContext`) over PGlite with the drobek core migrations;
- `src/skill.test.ts` — `checkSkill`, the SKILL.md gate of the built-in
  modules (`npm run check`);
- `README.md` — building, publishing and installing it on a server
  (`task selfhost:module:add`).

The guide is
[Writing a module](https://github.com/freema/drobek/blob/main/docs/MODULES.md#writing-a-module).
Licence: AGPL-3.0-only.
