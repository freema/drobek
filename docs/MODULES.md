# Platform modules

A **platform module** is the only way an app on drobek gets a backend. It is
platform code the **operator** installs, never code an app author or agent
uploads: the server still never executes app code. The contract is the
TypeScript package `@drobek/modules` (contract version `1.2.0`, semver:
`MODULE_CONTRACT_VERSION`).

A module contributes, for every app on the server:

| Piece | Where it shows up |
| ----- | ----------------- |
| **Routes** | `/__drobek/v1/<name>/…` on every app host (preview and production) |
| **SDK slice** | `drobek.<name>` in `/__drobek/sdk.js` (`import { drobek } from 'drobek'`) |
| **Per-app config** | validated by a zod `configSchema`; set by agents with `configure_module` |
| **Confirmation rules** | `confirmRequired(before, after, context)`: risky changes wait for the owner |
| **Secrets** | names only; values are entered in the dashboard, never through MCP |
| **Limits** | env-named numbers (`HELLO_WAVES_PER_MINUTE`), overridable per workspace |
| **Tables** | a drizzle migrations folder with its own journal |
| **Skill** | the agent-facing Markdown `skill_info('<name>')` returns |
| **Error codes** | its own codes with meaning and fix: `skill_info('<name>').errors`, `/llms-full.txt` |
| **Slots** | typed extension points other modules contribute to (see [Slots](#slots)) |
| **Jobs** | scheduled work core runs on an interval, for the server or for each app (see [Scheduled jobs](#scheduled-jobs-jobs)) |

This page has three audiences: **app authors** (you, or the agent building
your app) start at [Using modules in an app](#using-modules-in-an-app);
**operators** choose which modules their server runs in
[Enabling modules on your server (operators)](#enabling-modules-on-your-server-operators);
**module authors** read [The contract](#the-contract) and
[Writing a module](#writing-a-module).

## Using modules in an app

An app gets sign-in, stored records, forms or file uploads from the modules
the server runs; there is nothing to install. Each app uses them through the
SDK and configures them for itself.

**1. See what is available.** The built-in modules are
[`auth`](#the-built-in-auth-module) (sign-in with an e-mailed code or a
sign-in provider), [`data`](#the-built-in-data-module) (collections of
records with per-operation rules), [`forms`](#the-built-in-forms-module)
(submissions stored and e-mailed to the app's owners),
[`files`](#the-built-in-files-module) (end-user uploads),
[`email`](#the-built-in-email-module) (e-mails to the app's owners),
[`proxy`](#the-built-in-proxy-module) (calls to an external API with its key
added server-side), [`sync`](#the-built-in-sync-module) (scheduled imports
into a data collection) and [`oidc`](#the-built-in-oidc-module) (company
sign-in with an OpenID Connect provider, through `auth`). A server may run fewer or more:
`skill_info()` over MCP and the workspace's **Modules** tab in the dashboard
list the ones this server runs. `skill_info('<name>')` gives the agent the
module's code examples, SDK types, config schema, limits and error codes.

**2. Configure it for one app**, when the defaults are not enough. `forms`
and `files` work without configuration; `data` needs its collections
declared, `auth` its allow-list (the workspace's editors and admins can
always sign in), `proxy` a registered upstream. Either:

- the agent calls [`configure_module`](#configure_module-mcp-scope-write-role-editor)
  with a JSON merge patch, e.g.
  `{ "app_id": "…", "module": "data", "config": { "collections": { "todos": {} } } }`;
- or you open the app in the dashboard → **Modules** → the module, and edit
  the form ([The dashboard Modules tab](#the-dashboard-modules-tab-m2-02)).

`get_app` shows each module's config in force (`modules.<name>`).

**3. Confirm risky changes.** A change that opens the app up — sign-in to
anyone, data readable by the public, a new proxy upstream — is not applied
at once. `configure_module` answers `pending_confirmation` with a
`confirm_url`, and the workspace's editors and admins are told by e-mail
(when the server sends mail). One of them reviews the change on that
dashboard page and confirms or rejects it; a proxy change needs a workspace
admin ([Confirming a pending change](#confirming-a-pending-change)). Another
risky change made before that decision joins the waiting one, so both are
confirmed or rejected together. Each module's section below lists what waits
for confirmation.

**4. Set secrets in the dashboard.** A secret value (a sign-in provider's
client secret, an API key for the proxy) is never an MCP argument: you enter
it on the module's page or, for a proxy upstream, on the workspace's
**Upstreams** page. Tools return only its name and `hasSecret`.

**5. Use the SDK.** The app imports `drobek`; the compiler resolves it to the
server's SDK, so there is no package to add:

```tsx
import { drobek } from 'drobek';

const user = await drobek.auth.me(); // null when signed out
const todos = await drobek.data.collection('todos').list();
await drobek.forms.submit('contact', { email: 'ana@example.com', message: 'Hi' });
const photo = await drobek.files.upload(file); // a File from <input type="file">
await drobek.email.notifyAdmins('Stock is low', 'Only 3 left.');
const res = await drobek.proxy.fetch('weather', '/v1/today');
```

Ready-made React pieces come from `drobek/auth` (`<LoginGate>`) and
`drobek/forms` (`<Form>`). A failed call rejects with a `DrobekError`
(`code`, `message`, `hint`); the codes and their fixes are in
`skill_info('<name>').errors`. A module the server runs but has not enabled
for your workspace answers `module_not_enabled`: ask the operator.

## Enabling modules on your server (operators)

Which modules a server runs is the operator's choice, made in its environment:

```sh
DROBEK_MODULES=hello,auth,email,forms,data   # comma-separated; empty = no modules
```

Each entry resolves:

1. a short name `x` → the npm package **`drobek-module-x`**, which must
   export a module named `x`;
2. a full package name (`drobek-module-x`, `@scope/pkg`, anything with a `/`)
   → exactly that package, whatever `name` its module has. This is how an
   operator replaces a built-in module: `DROBEK_MODULES=@acme/drobek-module-auth,email,…`
   loads Acme's module named `auth` instead of `drobek-module-auth` (two
   entries loading one name still refuse the start).

The built-in modules of this repo live in `modules/<name>` as the workspace
packages `drobek-module-<name>`, dependencies of `apps/server` (and so of the
image). They load exactly like a third-party module: nothing in the registry
knows them by name. Built in: [`auth`](#the-built-in-auth-module) (end-user
sign-in), [`email`](#the-built-in-email-module) (notifications to the app's
owners, the app's mail policy), [`forms`](#the-built-in-forms-module)
(form submissions; requires `email`), [`data`](#the-built-in-data-module)
(collections of records with per-operation rules),
[`proxy`](#the-built-in-proxy-module) (calls to the workspace's registered
upstreams, secret injected server-side) and
[`files`](#the-built-in-files-module) (end-user uploads, sniffed types,
per-app quota).

A package is looked up in two places, in this order:

1. **`DROBEK_MODULES_DIR`** (default `/data/modules`, the `modules_data`
   volume): a module the operator installed there, checked against
   `modules.lock.json` — `source: 'dir'`, see
   [Installing an external module](#installing-an-external-module);
2. the **server's** install: `<cwd>/package.json` (`/app` in the image,
   `apps/server` in the dev stack), overridable with `DROBEK_MODULES_ROOT` —
   the built-in modules, or a dependency added in a derived image —
   `source: 'builtin'`.

The package's default export (or its `module` export) must come from
`defineModule()`.

The server **refuses to start** when anything is off: an unknown package, an
export that is not a module, an invalid name, a short name whose package
exports another name, defaults that fail the schema, a `contract` range the
server's `MODULE_CONTRACT_VERSION` does not satisfy (`module "crm": it needs
module contract ^2.0, but this server implements 1.2.0 — …`), two modules
with one name, a missing `sdk.entry`, a reserved name (`sdk`, `v1`,
`drobek`, `internal`, `errors`), a module whose `requires` is not enabled
(`module "forms" requires the module "email": add it to DROBEK_MODULES
(e.g. DROBEK_MODULES=…,email)`), a default module that requires an opt-in
one, `requires` that form a cycle, two modules declaring `mail` (or
`endUsers`, or `records`), one limit or error code declared by two modules,
a slot contribution that breaks the [slot rules](#slots), an invalid
`DROBEK_MODULE_<NAME>_DEFAULTS`, and for a module from `DROBEK_MODULES_DIR`:
a missing or mismatching `modules.lock.json` entry, changed files, a
migration outside its namespace. Nothing is skipped silently. A module
without `contract` still loads, with a warning naming the range to add. On
start the log `platform modules ready` lists every module as
`{ name, version, source, contract }` (`source`: `builtin` | `dir`; plus
`operatorOnly: true` on an [operator-only module](#operator-only-modules))
next to the server's contract version; `/healthz` and `/api/version` serve
the same `modules` list (never a path on disk).

### Operator defaults: `DROBEK_MODULE_<NAME>_DEFAULTS`

An operator changes a module's `configDefaults` for the whole server with a
JSON merge patch in `DROBEK_MODULE_<NAME>_DEFAULTS` (`<NAME>` = the module's
name in upper case), e.g. every app's sign-in open to one company:

```sh
DROBEK_MODULE_AUTH_DEFAULTS='{"allow":{"domains":["acme.com"]}}'
```

The patched defaults must pass the module's `configSchema` — otherwise the
server refuses to start with the issue paths
(`DROBEK_MODULE_AUTH_DEFAULTS: … — allow.domains: …`). They replace the
module's `configDefaults` everywhere: the effective config of every app that
did not set those keys, `skill_info('<name>').config.defaults` and the
dashboard's defaults. A variable naming no active module is ignored with a
warning.

### Per-workspace enabling (opt-in modules)

A module declared `availability: 'opt-in'` (a company module for one
customer, an experimental one for one team) is installed for the whole
server but **active only for the workspaces it is enabled for**. It is
active for a workspace when, in this order:

1. the [limits provider](#limits-and-the-limits-provider) answers
   `MODULE_ENABLED_<NAME>` for that workspace (`<NAME>` = the module name in
   upper case): `1` enables it, `0` disables it — also where a super-admin
   enabled it (a plan wins in both directions);
2. the operator's env sets `MODULE_ENABLED_<NAME>=1`: every workspace;
3. a super-admin enabled it in the dashboard (Workspace → Modules → Enable;
   the `workspace_modules` table, audited `module.workspace_enable` /
   `module.workspace_disable` with `meta.module`). Every other member sees
   the state on the same page read-only (who switched it on: workspace
   admins only), and the switch answers them 403. A super-admin's agent
   flips the same switch with the MCP tool `set_workspace_module` (scope
   `write`, `user_confirmed: true` after their explicit yes; audited with the
   agent as the actor); other users never see that tool. There is no
   self-service switch.

**`requires` applies per workspace.** An opt-in module is active only while
every module it `requires` is active for the workspace too, transitively
(a default required module always is) — whichever of the three decided its
own state. A plan or env value that enables a module whose required opt-in
module is off there leaves it off; so does disabling a module another one
depends on:

- **Enable** refuses while a required module is off for the workspace:
  `409 module_requires_not_enabled` (`details.missing` lists the modules to
  enable, in order; the dashboard shows the message with "Enable … first",
  and the Enable button stays disabled until then). Nothing changes.
- **Disable** always applies. The modules that depend on it keep their own
  switch but are off at once; the dashboard names them before (the card
  says "… depends on it: disabling it turns them off for this workspace
  too") and after the click, and they come back on when it is enabled
  again.

The workspace Modules page, `get_app.modules.<name>.enabled`,
`skill_info`'s `enabled_for_workspace` and every runtime check read the
same closure, so the dashboard and MCP always agree. A default module may
not require an opt-in one, and `requires` may not form a cycle: the server
refuses to start on either.

`ModuleRuntime.isEnabled(workspaceId, name)` answers it (a default module:
always `true`); `enabledModules(workspaceId)` returns the whole set once per
request. The provider answer is cached like every limit (60 s); the
dashboard switch is a primary-key read, so it applies at once. For a
workspace where the module is **not** active:

- its routes on the app hosts answer `404 module_not_enabled` (`details.module`,
  `hint: "skill_info('<name>')"`) whatever the path, and are not counted
  in `get_logs requests`;
- `configure_module` answers `isError` `module_not_enabled`; the owner's
  confirm of a change pending from before does too (reject still works);
- `get_app.modules.<name>.enabled` is `false` (a default module: always
  `true`); `create_app` / `get_app` `skills` and the briefing leave it out,
  and an `unresolved_import` compile hint does not point at its skill;
- `skill_info()` lists it with `availability: "opt-in"` (it is
  server-wide); with `app_id` the entry also carries
  `enabled_for_workspace`;
- the app's module page in the dashboard says "not enabled for this
  workspace" instead of the forms, and refuses changes;
- its `onAppCreate` / `onPublish` hooks do not run (`onAppDelete` always
  does);
- it contributes nothing to the [slots](#slots) of the modules that are on:
  their routes, `onAppCreate` / `onPublish` hooks and the end-user session
  check do not see its contributions — e.g. its sign-in provider is not
  listed, cannot begin, call back or complete a sign-in, its sign-in
  observer is not told, and a session it signed in ends on the next
  request.

The SDK stays one bundle per server (`/__drobek/sdk.js` includes opt-in
modules); an app just gets `module_not_enabled` from their calls. Per app a
module is "used" through its configuration, as for every module — there is
no per-app switch.

The dev compose enables both example modules and every built-in module
(`DROBEK_MODULES=hello,auth,email,forms,data,proxy,files,sync,oidc,drobek-module-acme-crm,drobek-module-ops-probe`,
the last two installed into `./.modules` by `task dev`, `HELLO_WAVES_PER_MINUTE=5`,
relaxed `AUTH_*` limits because every local request shares one client IP,
`DATA_MAX_DOCS_PER_APP=5` so the quota e2e trips quickly); so does the e2e
image compose, whose flow installs both external ones with
`selfhost:module:add`. `drobek-module-ops-probe`
(`tests-e2e/fixtures`) is an operator-only test fixture: its error reporter
`capture` (`ERROR_REPORTER=capture` in both composes) hands every report to
the e2e's `proxy-echo`, its e-mail transport `relay`
(`EMAIL_TRANSPORT=relay` in the dev compose and in the second phase of the
image flow, whose first phase keeps SMTP)
sends through Mailpit's HTTP API, and its server job fails when a spec asks
it to.

## Installing an external module

An operator adds a module without building an image by installing it into
`DROBEK_MODULES_DIR` (default `/data/modules`; the production compose mounts
the named volume `modules_data` there, part of `task backup`; the dev compose
bind-mounts `./.modules`):

```sh
task selfhost:module:add -- @acme/drobek-module-erp@1.2.0   # any spec npm accepts: version, tarball URL or path, git URL
task selfhost:module:list
task selfhost:module:remove -- erp
```

The runtime image has no package manager and never installs anything: npm
runs in a throwaway `node:22-alpine` container over the volume with
`--ignore-scripts` (no install script runs), then the drobek image's own
installer (`node node_modules/@drobek/modules/dist/cli/module-lock.js`)
checks the package, moves it to `<dir>/<name>` and records it in
`modules.lock.json`. The procedure, upgrades, rollback and a derived image
for operators with their own CI:
[`SELF-HOSTING.md` → Third-party modules](./SELF-HOSTING.md#third-party-modules).
The dev stack's `task module:add|remove|list` do the same over `./.modules`
with the host's npm.

```
/data/modules/
  modules.lock.json
  erp/                                  one install prefix per module, named after its `name`
    package.json  package-lock.json     what `npm install --prefix /data/modules/erp …` writes
    node_modules/@acme/drobek-module-erp/…
```

An entry of `DROBEK_MODULES` is found in `<dir>/<name>/node_modules/<package>`,
where `<name>` is the key of the lockfile entry for that package, or the short
name itself (`erp` → `<dir>/erp`), or the `<x>` of `drobek-module-<x>` /
`@scope/drobek-module-<x>`. The module loaded from there must be named
`<name>`. Only when none of these exists does the server fall back to its own
dependencies — so a module in the directory **wins** over a built-in package
of the same name.

**`modules.lock.json`** (in the root of the directory) records every
installed module:

```json
{
  "lockfileVersion": 1,
  "modules": {
    "erp": {
      "package": "@acme/drobek-module-erp",
      "version": "1.2.0",
      "resolved": "@acme/drobek-module-erp@1.2.0",
      "integrity": "sha512-…",
      "contract": "^1.1",
      "installedAt": "2026-09-26T12:00:00.000Z"
    }
  }
}
```

Before the server imports a module from the directory it checks that its
`package.json` names the package, that the lockfile lists `<name>` with the
same package and version, and that `integrity` equals the hash of the whole
install prefix `<dir>/<name>` (the package, its dependencies, package.json,
package-lock.json). Anything else refuses the start, naming the path and the
fix. The hash is `hashModuleTree()` from `@drobek/modules/lock` (the same
function writes and checks it): every file and symlink under the prefix,
sorted by its `/`-separated relative path, as `F <path>\0<sha512 hex>\n` or
`L <path>\0<link target>\n`, hashed with sha512 → `sha512-<base64>`; modes,
timestamps and empty directories do not count, a symlink leaving the prefix is
refused. `task selfhost:module:add` writes the entry with that function inside
the image, so the hash it records is the one the server computes.

**What `add` checks** before it records anything (a refusal leaves the
directory and the lockfile as they were; a failure after the move restores the
previous install):

- the package declares `@drobek/modules` in `peerDependencies`, and the range
  accepts the server's module contract version or its release version;
- nested copies of the host-provided peers (`@drobek/*`, `zod`,
  `drizzle-orm`, below) are deleted from its `node_modules`;
- the module is imported once to read its `name` (the directory name) and
  passes the server's `validateModule` — the `contract` range against
  `MODULE_CONTRACT_VERSION` included;
- after the move and the lockfile write it is loaded exactly as at start
  (lockfile + integrity, import, the migration lint below).

The `DROBEK_MODULES` entry it prints is the short name when the package is
`drobek-module-<name>`, else the full package name.

`DROBEK_MODULES_UNLOCKED=1` skips the lockfile check while developing a module
(the dev stack: put it into `./.modules/<name>/node_modules/<package>`, add it
to `DROBEK_MODULES`, `docker compose up -d drobek` — or use `task module:add`,
which writes the lockfile); with `NODE_ENV=production` the variable is ignored
with a warning.

**Host-provided peers.** Before the first module from the directory is
imported, the server registers a `node:module` resolve hook: every `import` of
`@drobek/*`, `zod`, `drizzle-orm` (and their subpaths) from a file under the
directory resolves to the **server's** instance — one `ModuleError` class, one
zod, one drizzle, whatever copies the module's `node_modules` holds. Imports
from anywhere else are untouched. So a module is an ES module (`"type":
"module"`; a CommonJS `require()` is not redirected) and declares these as
`peerDependencies`, best marked optional in `peerDependenciesMeta` so npm does
not install copies at all.

**Migration lint.** The migrations of a module from the directory are checked
at start (built-in modules are not — the `data` module's first migration
imports older core tables): `CREATE TABLE` / `CREATE INDEX … ON` /
`CREATE VIEW|SEQUENCE|TYPE` only for `mod_<name>` or `mod_<name>_*`;
`REFERENCES` only to its own tables, `apps(id)` or `workspaces(id)`;
`ALTER` / `DROP` / `TRUNCATE` only of its own objects; no
`CREATE FUNCTION|TRIGGER|EXTENSION|SCHEMA|ROLE|…`, no `GRANT` / `REVOKE` /
`COPY`. A violation refuses the start with the file and line
(`0000_init.sql:3: DROP TABLE: "users" is not a table of this module …`). Its
`migrations.folder` and SDK entries must lie inside its install prefix (the
part the integrity covers).

The lint keeps a module's schema in its namespace; it is not a sandbox. A
module runs in the server process with the whole database — install only
modules you trust ([`SECURITY.md`](./SECURITY.md)). An operator with their
own CI can instead bake the modules directory into a derived image
([`SELF-HOSTING.md` → Derived image](./SELF-HOSTING.md#derived-image)) — same
lockfile and lint — or add the module as a dependency of `/app`, where it
loads as `source: 'builtin'`, without lockfile or lint.

## The contract

```ts
import { defineModule, z } from '@drobek/modules';

export default defineModule<Config>({
  name: 'hello',                 // /^[a-z][a-z0-9]{1,30}$/: URL, drobek.<name>, config key, skill name
  version: '1.0.0',              // the module's own semver
  contract: '^1.1',              // the contract versions it works with (semver range vs MODULE_CONTRACT_VERSION)
  skill: { useWhen, markdown },  // useWhen: ONE sentence starting with the situation; optional only for an operator-only module
  configSchema,                  // zod; validates configure_module + the dashboard form
  configDefaults,                // the config of an app nobody configured (must pass the schema)
  salvageConfig(merged) { return { config, issues } }, // optional: the usable part of a stored config that fails the schema
  confirmRequired(before, after, { app, db }) { return [] }, // non-empty (or a Promise of it) → the change waits for the owner
  secrets: [{ name: 'HELLO_SIGNATURE', description, required?: boolean }],
  rules: { ops: { ping: 'public' } },           // operations shown in the rule editor
  limits: [{ env: 'HELLO_WAVES_PER_MINUTE', default: 30, meaning }],
  routes(r) { /* r.get / post / put / patch / delete */ },
  sdk: {
    entry: '/abs/path/sdk.js', types: 'export interface Api { … }',
    inline: { entry: '/abs/path/ui.tsx', types: '…' },       // optional: `import … from 'drobek/<name>'`
  },
  migrations: { folder: '/abs/path/migrations' },
  hooks: { onAppCreate(app, services) {}, onPublish(app, services) {}, onAppDelete(app, services) {} },
  endUsers: { current({ app, user, config, db, log }) {} },  // only the module that owns end-user sessions (auth)
  mail: { prepare(input) {} },   // only the module that owns the app's mail policy (email) — see "Module e-mail"
  records: { collections, query, get, remove, csv }, // only the module that stores app records (data) — see "The records authority"
  requires: ['email'],           // other modules this one needs; missing → the server refuses to start
  errors: [{ code: 'unknown_greeter', meaning, fix }], // its own error codes (see "Error codes")
  slots: { 'hello.greeter': { schema, unique: 'id', description } }, // extension points it offers (see "Slots")
  contributes: { 'auth.provider': { … } },        // its contributions to other modules' slots
  availability: 'default',       // 'default' (every workspace) | 'opt-in'
  dashboard: { editor: 'collections', title: 'Hello', description }, // the dedicated editor its config fits; its name for people
  jobs: [{ name: 'import', scope: 'app', every: (config) => config.every, run(ctx) {} }], // scheduled work (1.2, see "Scheduled jobs")
});
```

`@drobek/modules` also exports the types a module needs from the rest of
drobek — `DB`, `Logger`, `SdkCore` — so a module depends on
`@drobek/modules` alone. Its `exports` point at the built `dist/` (with
declarations), like `@drobek/sdk`'s.

Hooks run after `create_app` stored version 1, after a version was published
(MCP or dashboard) and after the app was deleted (`onAppDelete`, the
dashboard's delete: soft-deleted, its hosts answer 404 — the place to clean
up what the module keeps outside the database; its rows go with the app
purge `APP_PURGE_AFTER_DAYS` later, through `ON DELETE CASCADE`). They are
best effort: a failure is logged and never fails the call. `services` is
`{ db, log, contributions }` (see [Slots](#slots)).

The contract fields of 1.1:

| Field | Rules |
| ----- | ----- |
| `contract` | a semver range matched against `MODULE_CONTRACT_VERSION` (`1.2.0`); not satisfied → the start is refused; missing → a warning. The built-in modules and the example declare `'^1.1'`; `sync` (app jobs) declares `'^1.2'` |
| `errors` | `[{ code, meaning, fix }]`: `code` matches `^[a-z][a-z0-9_]{2,40}$`, is not a core code (`CORE_ERROR_CODES`, the catalogue in `/llms-full.txt`) and is declared by no other active module; meaning and fix are required |
| `slots` / `contributes` | see [Slots](#slots) |
| `availability` | `'default'` (the default: every workspace of the server) or `'opt-in'` (only the workspaces it is enabled for — [Per-workspace enabling](#per-workspace-enabling-opt-in-modules)); returned by `skill_info('<name>')` and the dashboard's module view |
| `dashboard.editor` | `'collections'` (a `collections` config shaped like `data`'s) or `'upstreams'` (an `upstreams` config shaped like `proxy`'s): declares which dedicated dashboard editor the config fits; `data` and `proxy` declare theirs. The dashboard picks the editor by this capability only, never by the module's name — a replacement module that declares it gets the same editor, a module without it gets the generic form |
| `hooks.onAppDelete` | `(app, services)` after the app was deleted, best effort |

The contract fields of 1.2 (additive: a module declaring `'^1.1'` loads unchanged):

| Field | Rules |
| ----- | ----- |
| `jobs` | `[{ name, scope?, every, description?, run }]` — see [Scheduled jobs](#scheduled-jobs-jobs). A module with jobs declares `contract: '^1.2'` (a 1.1 server ignores the field; the start logs a warning for a range that admits one) |
| `ModuleContext.pendingConfig` | the config once the owner confirms the app's pending change, or `null` — see [`ModuleContext`](#modulecontext). Optional in the type: a route reads it as `ctx.pendingConfig ?? null` |
| `AppJobContext.upstreams.fetch` / `.records.import` / `.audit` | an `app` job calls one of the app's upstreams through the module that owns them, writes a batch of records through the records module, and writes an audit row — see [Scheduled jobs](#scheduled-jobs-jobs) |
| `upstreams` | the owner of upstream calls (the built-in `proxy`; two refuse the start): `fetch(view, name, { method?, path?, headers?, body?, maxBytes? })` → `{ status, headers, body }` — what `ctx.upstreams.fetch` of a job reaches |
| `records.importRecords` | optional on the records authority: `(view, collection, records, { mode: 'replace' \| 'upsert', key? })` → `{ inserted, updated, deleted }`, all or nothing — what `ctx.records.import` of a job reaches |
| `sync` | the owner of scheduled imports (the built-in `sync`; two refuse the start): `sources(view)`, `runs(view, q)`, `runNow(ctx, source)`, `resume(view, source)` — what the dashboard's sources panel, MCP `sync_now` and `get_logs({ kind: 'sync' })` call ([The built-in `sync` module](#the-built-in-sync-module)) |
| `ConfirmContext.limits` | `confirmRequired`'s third argument may read the workspace's limits (`sync` refuses a source past its limits there) |
| `dashboard.title` / `dashboard.description` | the module's name for people and one line under it, for the app's owner — the dashboard shows "Scheduled imports (sync)" and the description in place of "Use when …" (written for agents). The `name` stays the identifier in URLs, the config key, MCP and `skill_info`. One line each (trimmed, no line break or control character), 1–60 / 1–200 characters, else the start is refused; a server that predates them ignores both |
| `ConfigFieldMeta` | the keywords the dashboard's config form reads from a `configSchema` field (zod `.meta()`): `title`, `description`, `x-drobek-choices`, `x-drobek-min-interval` — [Choices of a config field](#choices-of-a-config-field-x-drobek-choices); `x-drobek-rule`, `x-drobek-unit`, `x-drobek-default-limit`, `x-drobek-hidden`, `x-drobek-order` — [How a config field is shown](#how-a-config-field-is-shown). Presentation only |
| `OperatorModule` | a module declared without `skill` (`defineModule` types it `OperatorModule`; `DrobekModule` keeps `skill` required) — allowed only without an app surface ([Operator-only modules](#operator-only-modules)); a server that predates it refuses a module without a skill (`skill.useWhen is required`) |
| `ModuleSlot.operatorOnly` | `true` on a slot whose contributions configure the server, not apps (the core-hosted `errors.reporter`, `email`'s `email.transport`): a module contributing only to such slots needs no skill. Default `false`; anything but a boolean refuses the start |

### Operator-only modules

A module that serves only the server itself — an error reporter, an e-mail
transport — has nothing for an agent to read, so it may leave out `skill`.
That is allowed only while nothing of it reaches apps:

- no `routes`, `sdk`, `rules`, per-app `secrets`, own `errors` or `appInfo`;
- no app config: `configSchema` describes an empty object
  (`configSchema: z.object({}), configDefaults: {}`), and no `salvageConfig`,
  `confirmRequired` or `onConfirmed`;
- no owner authority (`endUsers`, `mail`, `records`, `submissions`, `files`,
  `upstreams`, `sync`), no `availability: 'opt-in'`, no `dashboard.editor`,
  no `scope: 'app'` job, no `compose`;
- every slot it declares and every slot it contributes to is
  `operatorOnly` — the core-hosted `errors.reporter` and the `email`
  module's `email.transport` are; `auth.provider`, `auth.signedIn` and
  `hello.greeter` are not.

`limits`, `migrations`, `hooks`, `requires`, server jobs and
`dashboard.title` / `description` are fine. `defineModule` types a module
declared without a skill as `OperatorModule` (a module with one stays a
`DrobekModule`, `skill` required); `AnyModule` is either. Anything else
refuses the start and names what reaches apps — `module "x": skill is required: the module
reaches apps through routes, secrets — add skill: { useWhen, markdown } …`,
or for a contribution `module "x" has no skill, but contributes to the slot
"auth.provider" (module "auth"), which reaches apps — …`.

Agents and app owners never see an operator-only module: `skill_info()`
does not list it and `skill_info('<name>')` answers `not_found` like an
unknown name; the briefing, `/llms.txt` and `/llms-full.txt`, `create_app` /
`get_app` (`skills`, `modules`), `configure_module` and the app's Modules tab
and module page leave it out, and `/__drobek/v1/<name>/…` answers
`not_found`. Nor is it named among the contributors of the slot it
contributes to: `skill_info('email')` and the `email` module page list no
module-provided transport under `email.transport`. Operators still see it: `/healthz`, `/api/version` and the start log
mark it `operatorOnly: true`, and the
[workspace Modules page](#the-workspace-modules-page) lists it, marked
operator-only, for super-admins only.

### Error codes

A route answers the core codes (`not_found`, `invalid_request`, `forbidden`,
`quota_exceeded`, … — `CORE_ERROR_CODES`) and the codes its module declares
in `errors`. A ModuleError with any other code is not sent: the server logs
it (`module request failed`, naming the code) and answers
`500 internal_error`, exactly like an unexpected exception —
`createModuleTestContext().request()` rejects on it, so a module's own tests
catch an undeclared code. `skill_info('<name>')` returns the module's
`errors`, and `/llms-full.txt` renders them after the core catalogue, one
section per active module. The built-in modules declare theirs: `auth`
(`email_not_allowed`, `invalid_code`, `too_many_attempts`), `forms`
(`submitted_too_fast`, `invalid_form_token`), `data` (`validation_failed`,
`invalid_schema`, `pending_confirmation`), `files` (`unsupported_type`), `proxy`
(`path_not_allowed`, `ssrf_blocked`, `upstream_error`, `proxy_busy`,
`config_error`); `oidc` (`oidc_discovery_failed`, `oidc_token_invalid`)
declares codes no route answers — its failures reach the app as auth's
`provider_error` — so agents can read the causes the server logs.

### Routes: `ModuleRouter`

```ts
r.post(
  '/wave',
  {
    rule: 'public',                                  // or (config) => config.access
    body: z.object({ name: z.string().min(1).max(40) }),
    query: z.object({ … }),                          // optional
    rateLimit: { bucket: 'wave', max: 'HELLO_WAVES_PER_MINUTE', windowMs: 60_000, per: 'ip' },
    maxBodyBytes: 1024,                              // default 32 KiB
    bodyTypes: ['json', 'multipart'],                // default ['json']; multipart = text fields only; 'raw' = the Buffer; ['file'] = one streamed file
    csrf: 'sdk-header',                              // default; 'same-origin' for sendBeacon-style calls
  },
  async (req, ctx) => ({ waves: 1 })                 // JSON 200, or respond(status, body, headers)
);
```

`rateLimit.per` keys the counter on the client IP (`ip`, the default), the
signed-in user (`principal`; the IP for an anonymous caller) or the app
(`app`). An IP-keyed limit needs a resolved client IP: a request without one
skips it instead of sharing one bucket with every other such client, so a
public route that must stay bounded also keeps an app-wide limit. A module's
own per-IP counter keys on `perIpLimitKey(req.clientIp, label)` (exported by
`@drobek/modules`; `null` = no IP, skip the check).

Patterns support `:param` segments (`/items/:id` → `req.params.id`) and a
trailing `*` that captures the rest of the path RAW (percent-encoded, no
leading slash) in `req.params['*']` (`/:upstream/*`, NSO-297). A handler also
gets `req.rawQuery` (the query string as sent, repeated keys intact) and
`req.headers()` (every request header, lower-cased names) — for pass-through
routes such as the proxy's; `bodyTypes: ['raw']` hands the body over as the
unparsed `Buffer` (any content type, `body` schema skipped). Every module
route goes through the same pipeline:

1. match module, method and path: `404 not_found` (an unknown module also
   lists `details.available`) or `405 method_not_allowed` (with `Allow`);
2. **CSRF** for POST/PUT/PATCH/DELETE: an `Origin`, when present, must be the
   app host itself; with `csrf: 'sdk-header'` the `X-Drobek-SDK: 1` header is
   also required (`403 csrf_rejected`);
3. the caller and this app's config → the route `rule` (`401` / `403`);
4. the rate limit (`429 rate_limited` + `Retry-After`);
5. the body: JSON (or, with `bodyTypes` including `multipart`,
   `multipart/form-data` with text fields only — a repeated name becomes an
   array, a file part is `415`); anything else `415`; size-capped (`413`),
   then the zod schema; the query too (`400 invalid_request` with
   `details: [{ path, message }]`). A `bodyTypes: ['file']` route instead
   gets the body UNREAD: `await req.file()` parses a `multipart/form-data`
   body with ONE file part (text fields may precede it, ≤ 64 KiB of headers
   and fields) and returns `{ field, filename, declaredType, fields, stream }`
   — `stream` yields the file's bytes as they arrive and the handler caps
   them itself (`maxBodyBytes` does not apply). Leaving the loop early
   discards the rest of the request without buffering it (the answer still
   reaches the client); whatever the handler did not read is discarded after
   it returns. `filename` / `declaredType` are the client's — never trust
   them;
6. the handler → JSON with `Cache-Control: no-store` (or `respond(status,
   body, headers)`: a string/Buffer is sent as-is, a Node `Readable` is
   streamed — e.g. a stored file — and destroyed unread for `HEAD`; a
   header whose value is a list is sent once per item, e.g. several
   `Set-Cookie`).

Every failure uses **one error shape**:

```json
{ "error": "invalid_request", "message": "…", "details": [{ "path": "name", "message": "…" }], "hint": "skill_info('hello')" }
```

Handlers throw `new ModuleError(code, message, { details, hint, headers })`.
Anything else becomes `500 internal_error` without internals (logged on the
server) — except a query the database cut off (the server's
`DB_STATEMENT_TIMEOUT_MS` / `DB_LOCK_TIMEOUT_MS`), which answers `503
unavailable` with `details.reason: database_timeout` and `Retry-After`. Codes: `invalid_request` 400, `unauthorized` 401,
`password_required` 401, `forbidden` 403, `csrf_rejected` 403, `not_found`
404, `method_not_allowed` 405, `conflict` 409, `payload_too_large` 413,
`unsupported_media_type` 415, `rate_limited` / `limit_exceeded` 429,
`internal_error` 500, `unavailable` 503. Every code has an entry in the
agent-facing error catalogue (`/llms-full.txt`).

Platform routes answer on an app host **after** the app is resolved and after
its visibility gate: a password-protected app answers `401
password_required` (JSON) until the visitor unlocked it. The apps-origin
security headers (CSP, `X-Content-Type-Options`, …) override whatever a module
sets.

### Access rules

A rule is a `|`-separated disjunction of `public`, `user`, `owner`, `admin`,
`none` (e.g. `"owner|admin"`). `owner` matches a signed-in end user whose id
equals the record's owner: `ctx.rules.decide(rule, ownerId)`.

### `ModuleContext`

Everything a handler gets is scoped to **one app and one module**:

| Field | Meaning |
| ----- | ------- |
| `app` | `{ id, slug, workspaceId }` |
| `principal` | `{ kind: 'anon' }` or `{ kind: 'user', id, email, role: 'user' \| 'admin' }`, resolved by core from the host-only end-user cookie (`__Host-drobek_eu`; plain-http dev: `drobek_eu`). A module never reads cookies, and the dashboard session is never read on an app host. |
| `config` | this app's effective config: `configSchema.parse(merge(configDefaults, stored))` |
| `pendingConfig` | the config this app would have once the owner confirms its pending change, or `null` (nothing pending, or it no longer validates). Never act on it — it is not in force; it lets a route say that something waits for confirmation (e.g. data's `409 pending_confirmation`). `createModuleTestContext({ pendingConfig })` sets it in tests. |
| `rules.decide(rule, ownerId?)` | `{ ok: true }` or `{ ok: false, status: 401 \| 403 }` |
| `limits()` | this workspace's limits (env defaults or the limits provider) |
| `rateLimit(bucket, key, max, windowMs)` | fixed-window counter in Redis, namespaced to the module and app |
| `secrets.get(name)` | the plaintext of a **declared** secret of this app, or `null`; reading an undeclared name throws |
| `audit(action, meta?)` | an audit row `<module>.<action>` for this app, actor kind `end_user` |
| `email.send({ to, subject, text })` → `{ sent }` | `to` is one reference or a list: `{ config: 'dotted.path' }` (addresses in this app's owner-confirmed config), `{ principal: true }` (the signed-in end user), `{ appOwners: true }` (the editors and workspace-admins of the app's drobek workspace) or `{ signInAddress }` (the address a visitor typed into a sign-in form: always alone, for a sign-in code only; the module decides first that it may sign in; only the module that owns end-user sessions — `endUsers`, the built-in `auth` — may use it, any other module gets `403 forbidden` with `details.reason: sign_in_address_not_allowed`). Never an arbitrary address. Addresses are validated, lowercased and de-duplicated; each gets its own message. The subject is one line (control and line-separator characters become spaces, 200 characters at most); the text (≤ 20 000 characters) is escaped into the drobek layout. Rejects with `limit_exceeded` / `unavailable` — see [Module e-mail](#module-e-mail). |
| `db`, `log` | the database (drizzle) and a logger |

### The SDK

`sdk.entry` is an ES module whose **default export** is `(core: SdkCore) =>
Api` (`SdkCore` from `@drobek/sdk`):

```ts
import type { SdkCore } from '@drobek/sdk';
export default (core: SdkCore) => ({
  ping: () => core.request<Hello>('GET', '/'),
  wave: (name: string) => core.request<{ waves: number }>('POST', '/wave', { body: { name } }),
});
```

`core.request` calls `/__drobek/v1/<module><path>`, sends `X-Drobek-SDK: 1`,
and rejects with `DrobekError { status, code, message, details, hint }` on a
non-2xx. `sdk.types` must declare an `interface Api`; it is wrapped in
`declare namespace <name> { … }` in `/__drobek/sdk.d.ts`.

At start the server bundles the core and every active module's entry with
esbuild into **one** ESM file, `/__drobek/sdk.js`, plus `/__drobek/sdk.d.ts`.
Both are served on every app host (never on the dashboard origin):

- the compiler maps an app's bare `import { drobek } from 'drobek'` to
  `/__drobek/sdk.js?v=<hash>` (the hash of the bundle);
- under the current `?v=` the file is `Cache-Control: public,
  max-age=31536000, immutable`; without it or under a stale `v` it is
  `public, max-age=0, must-revalidate`;
- both carry an `ETag`; a matching `If-None-Match` gets `304`.

Changing `DROBEK_MODULES` changes the hash; apps pick up the new SDK on their
next compile.

Two core paths sit next to the modules and are never a module name: the
beacon script `/__drobek/beacon.js?v=<hash>` (same caching as `sdk.js`; the
compiler imports it in front of every entry unless `drobek.json` has
`"beacon": false`) and the beacon endpoint `POST /__drobek/v1/_beacon`
(handled by core, 8 KiB cap). The beacon reports a page's load (once per
page, a count only), its uncaught errors and unhandled rejections, the files
that failed to load and the requests the CSP blocked, each with the version
the page was served from: every HTML response of an app host names it in
`Server-Timing: drobek-version;desc="<N>"`, which the beacon reads from the
page's navigation timing (a browser that does not expose it is filed under
the version the host serves when the report arrives). Page loads are counted
per version in `app_version_loads`, behind their own rate-limit buckets
(`drobek:rl:beacon-load:*`, the `BEACON_RATE_LIMIT` / `BEACON_APP_RATE_LIMIT`
values), so they never spend the error budget; only a version the app has
is counted. Every response of a MATCHED route of an active
module is counted per day and status class (`2xx`..`5xx`) — never a 429 (a
throttled flood costs nothing past the limiter) nor an unknown route or
method. The counters live in Redis (`drobek:signals:mod:<app_id>:<day>`) and
are written into `module_request_stats` lazily: at most once a minute per app
and day, and on every `get_logs({ kind: "requests" })` read, which flushes
its whole window (up to 31 days) in one pipelined Redis round trip and one
statement per table, then reads the table.

Everything `get_logs` returns is kept **30 days**: browser errors (at most
the newest `BEACON_MAX_EVENTS_PER_APP` = 500 per app, `BEACON_RETENTION_DAYS`
= 30), compiles (the newest 200 per app), the daily request and
module-call stats, and the page loads of a version (until no page of it
loaded for 30 days). Reads never delete: a periodic prune in the server process
(`LOGS_PRUNE_INTERVAL_MS`, default 1 h, one replica at a time via a Redis
lease) removes older rows for every app, also for apps nobody inspects. The
beacon stores a page URL as origin + path only: the SDK never sends the query
string or fragment, and the server strips them again.

#### Inline sources: `import … from 'drobek/<name>'`

Some SDK code must share the app's own libraries, e.g. a React component that
must use the app's React. `sdk.inline = { entry, types }` names one
TypeScript/JSX source file of the module. It is **not** in `sdk.js`: the
compiler builds it **into** the app that imports `drobek/<name>`, like one of
the app's own files:

- its bare imports resolve through the **app's** `drobek.json` import map
  (the app and the module share one React); a missing mapping is an
  `unresolved_import` that says what to add to `drobek.json`;
- `drobek` resolves to the server's `sdk.js` (the same `drobek.<name>`
  instance the app uses);
- relative imports are refused: the file must be self-contained;
- `types` is appended to `/__drobek/sdk.d.ts` and returned by `skill_info`
  (`sdk.inline { import, types }`).

An unknown `drobek/<x>` import is an `unresolved_import` listing the
available ones.

### Migrations and tables

A module with tables ships a drizzle migrations folder
(`migrations: { folder }`). On start the server applies it with the module's
**own journal**, `drizzle.__drizzle_migrations_mod_<name>`, after the core
migrations (`DROBEK_MIGRATE_ON_START=0` turns both off), under the same
migration lock. Migrations only go forward: when the journal holds migrations
the installed module version does not ship (a newer version migrated the
database), the server refuses to start and names the module and image
versions to run. Conventions:

- table names start with `mod_<name>_` (e.g. `mod_hello_waves`) — for a
  module from `DROBEK_MODULES_DIR` the [migration lint](#installing-an-external-module)
  enforces it;
- every per-app row references `apps(id)` with `ON DELETE CASCADE`, so deleting
  an app deletes its module data: a delete in the dashboard is a soft delete,
  and `APP_PURGE_AFTER_DAYS` (30) later the app purge deletes the `apps` row
  and, through the cascade, every module row of the app (the built-in
  modules' records, form submissions, end users with their identities,
  uploads and sync state). A reference without `ON DELETE` blocks the purge of
  that app: the server logs it and retries it on every run;
- a handler always filters by `ctx.app.id`.

### Module e-mail

Every `ctx.email.send` of every module goes through one path in core:

1. resolve the recipients (above); nobody → `{ sent: 0 }`;
2. the **operator-wide hourly cap** (`EMAIL_GLOBAL_HOURLY_MAX`, default 500
   recipients per hour across all apps and modules), split into two
   **classes** so a flood of notifications never locks end users out. A
   module does not choose its class: a message to `{ signInAddress }` (the
   auth module's code) is `sign_in`, anything else is `notification`.
   - `sign_in` gets a reserved share, `EMAIL_SIGNIN_HOURLY_MAX` (default
     `min(max(50, ⌈20 % × cap⌉), ⌊cap / 2⌋)` — 100 of 500; an explicit value
     is capped at cap − 1), and ONE app at most
     `EMAIL_SIGNIN_APP_HOURLY_SHARE` percent of it (default 25 → 25 of 100;
     at least 10, at most the whole sign-in budget) — one app can never pause
     sign-in for every app. `ctx.email.signInShare` tells a module that
     number (the auth module clamps `AUTH_CODES_PER_APP_HOUR` to it);
   - `notification` gets the rest (cap − sign-in, 400 of 500), and ONE app
     at most `EMAIL_APP_HOURLY_SHARE` percent of it (default 25 → 100 of
     400);
   - ONE workspace — all its apps together — at most
     `EMAIL_WORKSPACE_HOURLY_SHARE` percent of each class (default 50 → 200
     notifications and 50 sign-in codes of 500; never less than one app's
     share, never more than the class), so a workspace with several apps
     cannot take a whole class either. Both shares must pass.

   Past a class budget (Redis `drobek:rl:mail:<class>`), THAT class
   **pauses** for exactly `EMAIL_GLOBAL_PAUSE_MINUTES` (default 15, key
   `drobek:mail:paused:<class>`): tripping the pause restarts the class
   budget, so the first message after it starts a fresh hour instead of
   pausing again until the old hour ends (the apps and workspaces that used
   up their shares stay refused until their own hour ends). The server logs one line for the super
   admin: `level: error`, `message: "ALERT: module e-mail paused — …"`,
   `event: email_global_pause`, `alert: true`, `audience: super_admin`,
   `max` (the global cap), `class`, `class_max` (with the app and module
   that tripped it). While paused, every send of that class is refused with
   `503 unavailable` (`details.reason: email_paused`, `details.class`,
   `Retry-After`); the other class keeps going — form notifications and
   `notifyAdmins` pausing never stops sign-in codes. Deleting the pause key
   resumes early. An app past its share (`drobek:rl:mail:app:<app_id>`,
   sign-in: `drobek:rl:mail:app:<app_id>:sign_in`) gets the same `503` with
   `details.limit: EMAIL_APP_HOURLY_SHARE` (or
   `EMAIL_SIGNIN_APP_HOURLY_SHARE`) and `value` until its hour ends — other apps continue, nothing pauses server-wide
   (a `warn` line, `event: email_app_share_exceeded`). A workspace past its
   share (`drobek:rl:mail:ws:<workspace_id>`, sign-in:
   `drobek:rl:mail:ws:<workspace_id>:sign_in`) gets the same with
   `details.limit: EMAIL_WORKSPACE_HOURLY_SHARE` (`event:
   email_workspace_share_exceeded`). The budgets are not
   overridable by the limits provider, and a Redis error refuses the send
   (fail closed). `createModuleTestContext({ mailGuard: memoryMailGuard(…) })`
   runs the same guard in a module's tests;
3. the **mail authority**: the one enabled module that declares `mail` (the
   built-in `email`) runs `mail.prepare({ app, module, kind, recipients,
   config, limits, rateLimit, log })` with ITS config for the app. It applies
   the app's own policy (the per-app daily limit) and returns the envelope
   (`fromName`, `replyTo`). Without an authority only sign-in codes (`kind:
   sign_in`) can be sent; any other message is `503 unavailable`;
4. one message per address through the server's SMTP transport
   (`@drobek/email`, the same one the dashboard login uses), the sender
   address always the server's `EMAIL_FROM`; a transport failure stops there
   with `503 unavailable` (the error is logged with addresses redacted);
5. an audit row `email.send` (actor end_user) with the module, the kind and
   the recipient count — never an address.

### The records authority (the owner's view of app data)

The one enabled module that declares `records` (the built-in `data`; two
refuse the start) answers the app OWNER's questions about the app's stored
records. Core calls it only after it authorized a drobek account for the app
— MCP `query_data` (membership, viewer+), the MCP data write tools
(editor+) and the dashboard's Data tab (the workspace role; changes are
editor+) — never for an app host request, so it bypasses the end-user rules. Each call gets a `RecordsView`: the ONE app,
the module's effective config for it, `db` and `log`.

```ts
records: {
  collections(view)          // → [{ name, rules, schema, columns, records }]
  query(view, { collection, filter?, sort?, dir?, limit?, cursor? })
                             // → { collection, records, total, next_cursor }
  get(view, collection, id)  // → record | null
  remove(view, collection, id) // → boolean (dashboard delete, editor+)
  csv(view, { collection, filter?, sort?, dir? }) // → AsyncIterable of CSV lines (header first)
}
```

An undeclared collection is a `not_found` ModuleError, a bad filter/sort an
`invalid_request` (query_data maps them to `not_found` with the available
collections and `invalid_params`). `ModuleRuntime.records(app)` binds the
authority to one app (`BoundRecords`); without a records module it returns
null and both surfaces answer 404.

### The owner's edits and the other owner authorities (M2-03)

The dashboard's app tabs (Data, Forms, Users, Uploads, Logs) act for the
app OWNER through the same kind of owner-facing authority — core never reads
or writes a module's tables. The MCP data tools (`create_records`,
`update_record`, `delete_record`, `delete_collection`,
`purge_orphan_records`) reach the same `records` methods for the agent,
editor+, refused for a taken-down app; their audit rows carry actor kind
`agent`. Every authority call gets an `OwnerView`
(`RecordsView` is the same type): the app, the module's effective config,
`db`, `log` and `limits()` (the workspace's limits, memoized per call).
Loaders are viewer+, mutations editor+ (and the dashboard origin check);
core writes the audit row (actor kind `user`).

Optional `records` methods (the built-in `data` has all of them; a module
without one answers `unavailable`, and `orphans` lists nothing):

```ts
records: {
  update?(view, collection, id, fields, { merge? }?) // → record | null; the module validates (schema, size, quota)
  create?(view, collection, records)     // → the stored records, in order; ALL or nothing
  importCsv?(view, collection, csv)      // → { imported }; ALL or nothing
  dropCollection?(view, collection)      // → { records, configPatch }
  orphans?(view)                         // → [{ name, records }]: rows of undeclared collections
  purgeOrphan?(view, collection)         // → { records }; a declared collection → conflict
}
```

- `importCsv`: the header row names the fields (`_…` columns are skipped,
  empty cells omitted, cells typed by the schema); at most
  `RECORDS_IMPORT_MAX_ROWS` (5 000) data rows — the 5 001st is refused before
  anything is written (`payload_too_large`). Every row is validated first; the
  first bad one is a `validation_failed` whose message and `details.line`
  name its line, and nothing is stored (one transaction under the app's
  write lock). An owner import **bypasses `DATA_WRITE_RATE_LIMIT`** (a
  deliberate bulk action by the owner, not app traffic) but **not** the
  quotas: `DATA_MAX_DOCS_PER_APP`, the per-app bytes and the per-record size
  still apply. Dashboard: `data.import` (row count only).
- `update`: replaces the record's own fields (the dashboard's JSON editor);
  `merge: true` merges them onto the stored ones like the SDK's update (MCP
  `update_record` by default). Both build the new fields from the row as it
  is under the app's write lock.
- `create` (MCP `create_records`, at most 500 records per call): new records
  without an owner, every one checked (schema, per-record size) before one
  transaction stores them all against the quotas; the first bad one is a
  `validation_failed` with `details.index`, and nothing is stored. Like the
  import it bypasses `DATA_WRITE_RATE_LIMIT`, never a quota. Audit
  `data.record_create` (collection + count).
- `dropCollection`: deletes the records and returns the config patch that
  removes the collection; core applies the patch through the same path as
  `configure_module` (config lock, merge-patch, `validateConfig`) and writes
  the records deletion, the config and the `data.collection_delete` audit in
  ONE transaction. The dashboard asks the owner to type the collection name;
  MCP `delete_collection` needs `user_confirmed: true` (the user's explicit
  yes) and takes the app's single-writer lease like `configure_module`.
- `orphans` / `purgeOrphan` (NSO-324): records whose collection the config no
  longer declares — e.g. a write that landed while the collection was being
  removed — are invisible to every other view but still count towards the
  quotas. The Data tab lists them with their counts; an editor purges one
  after typing its name (under the config lock, so it cannot be declared
  meanwhile; audit `data.collection.purge` with `orphan: true`). MCP
  `purge_orphan_records` purges one or every orphan collection with
  `user_confirmed: true`.

Optional `endUsers` owner methods (the built-in `auth` has them):

```ts
endUsers: {
  current(...)                          // the per-request principal (required, as before)
  list?(view, { search?, limit?, cursor? })   // → { users, total, next_cursor }
  setRole?(view, id, role)              // → { user, configPatch }
  setDisabled?(view, id, disabled)      // → user | null
}
```

`setRole` returns a config patch (auth: the address into / out of
`adminEmails`, and into `allow.emails` when demoting someone the config would
otherwise not let in); core applies it like `dropCollection` and audits
`end_users.role`. Because core asks the module about the user on every
module request, the new role applies to the very next request. A workspace
editor is always admin (`conflict`, `details.reason: 'workspace_editor'`).
There is no per-user sign-out (sessions are not indexed per user): blocking
ends a user's sessions at once, and "sign everyone out" is the app's session
epoch (`end_users.sessions_revoke`).

New optional authorities (at most one enabled module each, like `records`):

```ts
submissions: {                          // built-in forms
  forms(view)                           // → form names
  list(view, { form?, from?, to?, limit?, cursor? })  // → { submissions, total, next_cursor }
  csv(view, query)                      // → AsyncIterable of CSV lines (formula-neutralized)
  remove(view, id)                      // → boolean
}
files: {                                // built-in files
  list(view, { limit?, cursor? })       // → { files, next_cursor, used_bytes, quota_bytes }
  open(view, id)                        // → { file, stream } | null
  remove(view, id)                      // → boolean (the module's cross-app dedup rule for the bytes)
}
```

`ModuleRuntime.submissions(app)` / `.files(app)` / `.endUsers(app)` bind them
to one app (null without such a module; the tab then says the module is not
enabled). The dashboard serves an upload's bytes on its own origin only with
the module's sniffed type, `nosniff`, `Content-Security-Policy: default-src
'none'; sandbox`, and `inline` only for PNG / JPEG / GIF / WebP (everything
else, SVG and PDF included, is an attachment).

The agent reaches the same bindings over MCP, with the tabs' role floors
(viewer+ reads, editor+ changes) and audit rows (the agent as the actor):
`list_form_submissions` / `delete_form_submission` (`submissions`),
`list_end_users` / `set_end_user_role` / `set_end_user_blocked` /
`sign_out_end_users` (`endUsers` and the session epoch), `list_uploads` /
`delete_upload` (`files`; never an upload's bytes). The lists answer only
inside an untrusted envelope, at most 100 entries and 64 KiB per call;
`set_end_user_role` passes `surface: 'mcp'` so `end_users.role` records the
agent, and takes the app's single-writer lease because it changes the
config. A module error becomes the tool error the agent acts on:
`invalid_request` → `invalid_params`, `not_found`, `conflict` (with
`details.reason` as `reason`), `unavailable`. `remove_module_secret`
deletes one declared secret of the app after the user's explicit yes
(audited `module.secret_remove`); no tool sets or reads a value.

## Scheduled jobs (`jobs`)

The server never runs app code, so work on a schedule — refreshing an app's
data from an API every 15 minutes, a nightly clean-up — belongs to a module:
it declares `jobs` (contract 1.2) and core runs them in the server process.

```ts
export default defineModule<Config>({
  name: 'scores',
  contract: '^1.2',
  // …
  jobs: [
    {
      name: 'refresh',                    // ^[a-z][a-z0-9_]{1,39}$, unique in the module
      scope: 'app',                       // once per app, with that app's config
      description: 'fetches the latest scores',
      every: (config) => (config.feedUrl ? config.every : null), // '15m', or null: not for this app
      async run(ctx) {
        const key = await ctx.secrets.get('SCORES_API_KEY');
        const res = await fetch(ctx.config.feedUrl, { headers: { authorization: `Bearer ${key}` }, signal: ctx.signal });
        if (!res.ok) throw new Error(`the feed answered ${res.status}`); // → get_logs runtime, retried with backoff
        // write the rows with ctx.db into the module's own tables
      },
    },
    { name: 'prune', every: '1d', async run(ctx) { for await (const { app, config } of ctx.apps()) { /* … */ } } },
  ],
});
```

| Field | Rules |
| ----- | ----- |
| `name` | `^[a-z][a-z0-9_]{1,39}$`, unique within the module |
| `scope` | `'server'` (the default): one run per interval for the whole server. `'app'`: one run per interval for **each app** that has a stored config of the module (a `configure_module` call, a dashboard save or a pending change), is live (not deleted, not taken down) and has the module on for its workspace |
| `every` | milliseconds or a count with a unit — `'30s'`, `'5m'`, `'1h'`, `'1d'` — between 1 minute and 30 days (else the start is refused). An `app` job may pass `(config, app) => interval \| null` instead: read per app on every tick, `null`/`undefined` = not for this app now, an invalid value is skipped with a warning, a value outside the range is clamped to it |
| `description` | one line; `skill_info('<name>').jobs` lists `{ name, scope, every, description }` (`every: 'config'` for one read from the config) |
| `run(ctx)` | the work. A throw (or a rejection) fails the run |

`run` gets the module's services — `db`, `log` (tagged with module, job and
app), `contributions`, `module`, `job` — plus `signal` (aborted at the
timeout or on shutdown: pass it to `fetch`) and `lastSuccessAt` (when the
last successful run of this job, for this app, started — `null` the first
time; an import can ask its source for what changed since). A `server` job
also gets `limits()` (the server's defaults) and `apps()`, an async iterator
over the same apps an `app` job runs for (`{ app, config, db, log }`). An
`app` job gets the app's context without a caller: `app`, `config`,
`pendingConfig`, `limits()` (the workspace's), `rateLimit()` (the same
buckets as the module's routes) and `secrets.get()` (declared names only).
A job sends no e-mail.

An `app` job also reaches the app's other capabilities through core, never
another module's code:

- `ctx.upstreams.fetch(name, { method?, path?, headers?, body?, maxBytes? })`
  calls an upstream the app's proxy config assigns, through the module that
  owns upstream calls (`proxy`): the registered, admin-confirmed record, its
  method and path allow-lists, the secret injected server-side, the SSRF
  guard, 20 s and the lower of `PROXY_MAX_RESPONSE_BYTES` and `maxBytes`. The
  job never sees the secret. There is no caller, so no call rule applies — an
  upstream assigned with `call: "none"` works. Without an enabled `proxy`:
  ModuleError `unavailable`.
- `ctx.records.import(collection, records, { mode, key? })` writes a batch
  into a collection through the records module (`data`): every record passes
  the collection's schema, the size and the app's quotas, in one transaction
  — `replace` leaves exactly the batch, `upsert` replaces the records with
  the same `key` and adds the rest. A bad record refuses the whole batch
  (`validation_failed` with `details.index`); nothing changes.
- `ctx.audit(action, meta?)` writes an audit row `<module>.<action>` about
  the app. A scheduled run has no person behind it: the row has no user
  (the Activity view shows "system") and `meta.by: 'schedule'`; a run a
  person started (the sync authority's `runNow`) names them.

How core runs them:

- A scheduler looks for due runs every 15 seconds. Each job (for each app)
  keeps its state in Redis — when it last ran, when it last succeeded, how
  many runs failed in a row — so a restart or another replica continues where
  the last run left off; a run is due one interval after the last one, the
  first one at once.
- A Redis lease per run makes sure it runs **once across replicas**.
- At most `MODULE_JOBS_CONCURRENCY` (4) runs are in flight per process; a
  due run past the cap waits for a later tick. A run is cut off after
  `MODULE_JOBS_TIMEOUT_MS` (5 minutes): its `signal` aborts and the run
  counts as failed. A run that ignores the signal keeps its lease a minute
  longer, then the next run may overlap it.
- A failed run is logged (`module job failed`, with module, job, app, the
  failures in a row and the retry delay, secrets redacted) and retried with
  backoff: 1 minute, doubling per failure, at most the job's interval or an
  hour, whichever is longer; a success resets it. An `app` job's failure is
  also in the app's `get_logs({ kind: 'runtime' })`: type `module_job` with
  `module` and `job`, the redacted message and an empty `url` — the agent
  sees it where it looks for errors.
- Nothing runs before the first tick after the start, and a scheduling error
  is logged, never thrown: a job cannot hold up the server's start or its
  requests. `MODULE_JOBS_ENABLED=0` turns the jobs off on one process (e.g.
  all replicas but one); a server whose modules declare no jobs starts no
  scheduler at all.

`createModuleTestContext(module, { config, secrets, … }).runJob(name)` runs a
job once the way the scheduler does (see [Testing a module](#testing-a-module)).

## Slots

A slot is a typed extension point one module (the **host**) offers the
others: the host declares it with a zod schema, other modules contribute a
value to it, and the host reads the contributions. It is how a module is
extended without forking it — e.g. another module adding a way to greet to
the example's `hello.greeter`.

```ts
// the host (the example module hello)
slots: {
  'hello.greeter': {
    schema: z.object({ id: z.string(), greet: z.custom<(name: string) => string>((v) => typeof v === 'function') }),
    unique: 'id',                                  // optional: a key whose value must be unique in the slot
    description: 'Another way to greet: greet(name) returns the text.',
  },
},
routes(r) {
  r.get('/greet', { rule: 'public' }, (req, ctx) => {
    const greeters = ctx.contributions<Greeter>('hello.greeter'); // [] when nobody contributes
    // …
  });
},

// a contributor (any other active module)
contributes: {
  'hello.greeter': { id: 'pirate', greet: (name) => `Ahoy, ${name}!` },
},
```

The rules, all checked when the server starts (a violation refuses the start
with a message naming the module and the slot):

- a slot name is `<host name>.<name>` (`^[a-z][a-z0-9]*\.[a-z][a-zA-Z0-9]*$`)
  and starts with the name of the module that declares it; a slot has a
  `schema` and a `description`, and `operatorOnly: true` when its
  contributions configure the server, not apps (a contributor without a skill
  may contribute only to such slots — [Operator-only modules](#operator-only-modules));
- a module contributes at most one value per slot (`contributes` maps slot
  name → value); the slot must be declared by an ACTIVE module or hosted by
  core (`errors.reporter`, below) — a contribution to a slot of a module that
  is not in `DROBEK_MODULES`, or that it does not declare, refuses the start;
- every contribution must pass the slot's schema;
- with `unique: '<key>'`, two contributions with the same value of that key
  refuse the start (`modules "a" and "b" both contribute id "x" to the slot
  "…"`). Without `unique`, contributions never conflict.

`contributions<T>(slot)` is on `ModuleServices` — the request's `ctx`, the
`services` of every hook — and returns the values as the slot's schema
parsed them (a `z.object` drops unknown keys; use `z.looseObject` to keep
them), in `DROBEK_MODULES` order. A slot nobody contributes to, or that no
active module declares, gives `[]`. The generic types the value; the schema
is what guarantees it. At run time only the modules that are on for the
app's workspace contribute ([opt-in](#per-workspace-enabling-opt-in-modules)
modules switched off there are left out) — in a route's `ctx`, the
`onAppCreate` / `onPublish` services, `endUsers.current` and the end-user
callback's `app()` view; the callback's own `services` (no app known yet)
hold the default modules' only. `onAppDelete` gets every contribution, so a
module switched off since can still clean up. `compose` (below) sees all of
them: the config schema is one per server.

**`compose`** — a host whose config, confirm rules or secrets depend on the
contributions (the auth module: one `providers.<id>` entry, identity-field
confirmations and secrets per sign-in provider) declares
`compose({ contributions }) → { configSchema?, configDefaults?,
salvageConfig?, confirmRequired?, secrets? }`. Core runs it once at start,
after the contributions are collected (`checkModuleSet`, and
`createModuleTestContext` with its `contributions` option), and the returned
parts replace the declared ones — validated like a declared module (a zod
schema, defaults that pass it, unique UPPER_SNAKE secret names, functions).
Only a module that declares slots may compose; any other key, or a throw,
refuses the start. The declared parts stay the module's view of a server
without contributions.

### Error reporters from modules

Server errors always go to the log (container stdout). A module can also
send them somewhere else (an incident webhook, a log service, …) by
contributing to the `errors.reporter` slot. Core hosts this slot — there is
no `errors` module (the name is reserved), so the reporter's module is the
only one it needs. The slot is `operatorOnly`, so the module needs no skill:
it is [operator-only](#operator-only-modules), never shown to agents or app
owners:

```ts
import { defineErrorReporter, defineModule, z } from '@drobek/modules';

export default defineModule({
  name: 'webhookerrors', version: '1.0.0', contract: '^1.2',
  configSchema: z.object({}), configDefaults: {},
  contributes: {
    'errors.reporter': defineErrorReporter({
      apiVersion: 1,                    // optional; 1 is the reporter API this server implements
      id: 'webhook',                    // 2–16 lowercase letters and digits
      label: 'Incident webhook',
      secrets: ['ERRORS_WEBHOOK_URL'],  // operator env vars, read at start
      async report(event, { secrets, signal }) {
        const res = await fetch(secrets.ERRORS_WEBHOOK_URL, {
          method: 'POST', signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      },
    }),
  },
});
```

- **Selection.** `ERROR_REPORTER=<id>` makes the contribution with that id
  receive the server's errors; unset or empty, errors are only logged. The
  server refuses to start when no active module contributes the id, a
  declared secret is unset, or two contributions take one id.
- **What is reported**: a 5xx of the dashboard (React Router) or the Express
  app (`kind: 'http'`), a module route that throws (`module_route`, answered
  `500 internal_error`), a failed or timed-out module job (`module_job`), a
  failed e-mail send through any transport (`email`), a start-up failure
  once the reporter is installed — module migrations and everything after
  the modules load (`startup`, `level: 'fatal'`; the server waits for the
  report, at most the timeout, before it exits) — and an error nothing
  caught, an uncaught exception or unhandled promise rejection (`process`,
  `level: 'fatal'`; the server stops gracefully and exits with code 1 once
  the report went out or timed out).
- **The event**: `{ level, message, error?: { name, message, stack? },
  context: { kind, route?, method?, status?, module?, job?, appId?,
  workspaceId?, requestId? }, release, environment, timestamp, fingerprint }`.
  `release` is `DROBEK_VERSION` (else `GIT_SHA`), `environment` is
  `NODE_ENV`; `fingerprint` is stable for the same error at the same place.
  It never carries request bodies, headers, cookies or query strings;
  `route` is the path (a module route its pattern, e.g.
  `/__drobek/v1/forms/submit`) with long opaque segments read `:param`.
  E-mail addresses, bearer / JWT tokens, `key=value` secrets, the reporter's
  secret values and the server's own secrets are redacted from every text;
  a database error reads `db error <code> (constraint …, table …)` —
  never its SQL or bound values.
- **Never in the way.** `report` runs after the response is decided and is
  never awaited by a request. It is cut off after `ERROR_REPORTER_TIMEOUT_MS`
  (default 5000: `ctx.signal` aborts); whatever it throws, and a timeout,
  is logged once per minute (secrets redacted) and dropped. At most
  `ERROR_REPORTER_MAX_PER_MINUTE` reports (default 60) go out per minute —
  over it, one warning per minute and the rest are only logged — and an
  identical error (same fingerprint) goes out once per minute. An error
  inside `report` itself is never reported.
- **Secrets** are server-level, as for e-mail transports: env var names in
  `secrets`, values in `ctx.secrets`, never module secrets of the dashboard,
  never over MCP, never logged.

## Per-app configuration

Stored in `module_configs` (`app_id`, `module`, `config` jsonb, `pending`
jsonb, `updated_at`; primary key `(app_id, module)`, cascade on app delete).
`config` holds only what was set, as a sparse **JSON merge patch** (RFC 7396)
over `configDefaults`; the effective config is re-validated on every read.
A stored config that no longer passes `configSchema` (a legacy import, a hand
edit) is served through the module's optional `salvageConfig(merged)` — it
returns `{ config, issues }`, the runtime logs the issues once per stored
content (`warn`, "serving its valid part") — or, without it, as
`configDefaults`. `configure_module` still validates the whole config, so the
next change has to repair it. `data` keeps every collection that is valid on
its own (even past its cap of 100) and drops only the invalid ones.
Secret values never live here (they live encrypted in `module_secrets`).

### `configure_module` (MCP, scope `write`, role editor)

```json
{ "app_id": "…", "module": "hello", "config": { "greeting": "Ahoj" } }
```

`config` is a merge patch (`null` removes a key). The tool takes the app's
single-writer lease, merges the patch, and validates the result. Then:

- **invalid** → `invalid_params` with `issues: [{ path, message }]` and
  `hint: "skill_info('hello')"`;
- **something that looks like a secret value** (an API key, a private key, …)
  → `invalid_params`: secrets are set only in the dashboard;
- **unchanged** → `{ applied: true, unchanged: true, … }` (nothing written);
`confirmRequired(before, after, context)` gets both configs VALID and
effective, and `context = { app, db }`: the app (id, slug, workspace) and the
configure transaction (the config row is locked) for read-only lookups — e.g.
the data module asks whether a collection whose schema is being removed holds
records. It may return a Promise. An item may be `{ change, confirmRole:
'admin' }` instead of a string (NSO-322): then only a **workspace admin** (or
a super-admin) can confirm the pending change — an editor gets `403
forbidden` with `details.reason: admin_required` and may still reject it —
and `configure_module` / `get_app` add `confirm_role: "admin"`. The proxy
module marks every change this way (only admins register upstreams).
`onConfirmed(before, after, { app, db, userId, role, audit })` runs inside
the confirm transaction after a confirmation (a throw rolls it back) — proxy
puts the app on the upstream's allow-list there, data purges the records of
a removed collection. `audit(action, meta)` writes `<module>.<action>` in that
transaction (actor: the confirming user).

- **`confirmRequired` is empty** → written at once (audit `module.configure`,
  actor agent): `{ applied: true, config, pending_confirmation: [] }`;
- **`confirmRequired` names changes** → stored as the app's pending change
  (audit `module.pending`, actor agent), the config in force stays:
  `{ applied: false, config, pending_confirmation: ["greeting: \"Hello\" → \"Ahoj\""], confirm_url }`.

An app has at most one pending change per module, and a newer proposal
never replaces it: a call whose `confirmRequired` names changes while one
waits **joins** it. The two patches are composed (the waiting one, then the
new one) into one patch over the config in force, the result is validated
as a whole and `confirmRequired` runs again from the config in force to it,
so `pending_confirmation` lists what the combined change needs (a change the
new patch undoes drops out). It needs a workspace admin when either part or
the combined change does. The answer adds `merged_with_pending` (the changes
that were waiting before), the audit row `module.pending` the same key, and
the owner sees one before → after diff: Confirm applies all of it, Reject
drops all of it. A proposal that does not fit the waiting change answers
`invalid_params` with the issues and `pending_confirmation` (what waits);
nothing is stored. A dashboard save (`surface: 'web'`) joins the same way. A
call that needs no confirmation is written at once and leaves the waiting
change as it is.

Required secrets that are not set yet come back as `secrets_missing:
["NAME"]` (names only).

`get_app` returns `modules.<name>`: `{ configured, config, pending,
pending_confirmation?, confirm_url?, secrets: [{ name, hasSecret }], info? }`.

`info` is the module's optional `appInfo(view)` (NSO-297): secret-free facts
about the module's state for the app (`view = { app, config, db, log }`),
also returned by `configure_module` for the config now in force. The proxy
module lists the workspace's upstreams with `hasSecret`; never put a secret
value, another app's data or anything the agent must not see there. A
throwing `appInfo` is logged and left out.

### Confirming a pending change

`confirm_url` is the dashboard page
`<DASHBOARD_ORIGIN>/workspaces/<ws>/apps/<slug>/modules/<module>` where the
owner reviews the change. The page (or any dashboard client) calls:

```
POST /api/apps/:app_id/modules/:module/confirm
POST /api/apps/:app_id/modules/:module/reject
```

- a dashboard session is required (`401 unauthorized` otherwise);
- an `Origin` header equal to the dashboard origin is **required** (`403`
  without one or with an app host's origin);
- the caller must be an editor or workspace-admin of the app's workspace (or a
  super-admin); a missing app and a non-member both get `404 not_found`, a
  viewer `403`;
- nothing pending → `409 conflict` (`details.reason: 'nothing_pending'`); a
  pending change that no longer validates → `409 conflict`
  (`details.reason: 'pending_invalid'`, with the issues);
- `confirm` applies the change (audit `module.confirm`, actor user):
  `{ ok: true, decision: 'confirm', module, config, confirmed: [...] }`;
- `reject` drops it (audit `module.reject`, actor user):
  `{ ok: true, decision: 'reject', module, config, rejected: [...] }`.

**The owner is told by e-mail** (M2-02): when an agent's `configure_module`
leaves a change pending, core e-mails the app's owners (`{ appOwners: true }`
— the editors and workspace-admins) through the normal module e-mail path:
the mail authority (the `email` module: its per-app daily limit and
envelope) and the operator-wide `notification` budget. At most **one e-mail
per app per hour** (Redis `drobek:rl:modules:pending-mail:<app_id>`); each one
lists every module of the app that is waiting, its confirmRequired strings
and its review URL, so a burst of proposals is aggregated. Without an active
mail authority nothing is sent, and a refused send is logged — it never fails
the tool call. A change the owner makes in the dashboard form sends no e-mail.

### The dashboard Modules tab (M2-02)

The dashboard knows no built-in module by name: dedicated editors follow
`dashboard.editor`, the Data / Forms / Users / Uploads tabs follow the
authorities (`records`, `submissions`, `endUsers`, `files`). A replacement
module or a third-party one gets the same pages (a grep guard in
`@drobek/dashboard` keeps it that way).

`/workspaces/<ws>/apps/<slug>/modules` lists the active modules for the app
(configured or defaults, what waits, missing required secrets; never an
[operator-only module](#operator-only-modules), which has no module page
either), each under
its `dashboard.title` with its name — "Scheduled imports (sync)" — and its
`dashboard.description` (else "Use when …"), like the module page's
heading; the app page
shows a "N changes await confirmation" banner (`PendingBanner` +
`loadPendingBanner()` in `@drobek/dashboard`). The module page (the
`confirm_url`) has, top to bottom:

- **the pending change**: who proposed it last and when, the module's
  confirmRequired strings each with a plain-language risk note, a
  before → after table of every changed path of the effective config, and
  Confirm / Reject (the same `runtime.confirm` / `reject` as the API above)
  — one decision for everything listed, also when several proposals were
  joined into it;
- **the configuration form**, generated from the module's `configSchema`
  (zod → JSON Schema, input side) by the dashboard's own renderer: objects
  (nested), string, string enum (a select), number / integer (with
  `min` / `max`), boolean, arrays of strings (one per line), arrays of a
  string enum (checkboxes), **records of named entries**
  (`z.record(…)` — `additionalProperties`) and **arrays of objects**. A
  record or list renders each entry with its own fields (recursively), a
  "Remove" checkbox per entry and one empty entry to add a new one (a record
  entry needs a name, labelled by the `title` / `description` of the
  record's key schema — `z.record(z.string().meta({ title: 'Form name' }), …)`
  — else "Name"); entries nest up to 3 levels deep, below that a value
  is a JSON field. Anything else — unions, a record of anything
  (`z.record(z.string(), z.unknown())`) — is a JSON field. The zod
  `.describe()` text (JSON Schema `description`) is shown under the field.
  A string field annotated with `x-drobek-choices` is a select of existing
  things ([Choices of a config field](#choices-of-a-config-field-x-drobek-choices));
  rule strings, sizes in bytes, values a control of their own sets and the
  order of an object's keys have keywords too
  ([How a config field is shown](#how-a-config-field-is-shown)).
  The empty option of a select names the default ("Default (1h)"), or reads
  "Choose…" for a required field and "(not set)" otherwise.
  No client JS: the form posts plain fields; the server
  rebuilds the config, turns it into a merge patch against the config in
  force and runs **the same configure path as `configure_module`**
  (`surface: 'web'`: audit actor `user`), so a relaxation becomes a pending
  change there too. The module's schema is the only validator: its issues
  come back at their fields (`allow.emails[0]` → the `allow.emails` field;
  an issue inside a record / list entry at the record / list, naming the
  entry). Give fields a `title` / `description` in zod (`.meta()` /
  `.describe()`) to label them — the label is the `title`, the config key
  itself is listed only under the collapsed "Config keys for agents". Each
  top-level setting is tagged **Default** (nothing saved for the app, the
  module's default applies) or **Saved for this app**, and a setting a
  pending change touches shows its value after confirming next to the
  value in force. The `*` mark means "must have a value" and appears only
  on text, number and select fields: a list, record or checkbox the schema
  requires is always sent (an empty list, `false`), so its hint says
  instead whether it can be left empty (`minItems`) and how many items it
  takes (`maxItems`). Saving sends only what differs from the config in
  force, so an untouched default stays a default;
- a module declaring **`dashboard.editor: 'collections'`** (the built-in
  data module) gets a collections editor instead of form fields for its
  `collections` key: per collection a table operation × principal (Anyone,
  Signed-in users, Record owner, App admins; nothing checked = `none`) and
  the JSON Schema textarea; add / remove a collection. A module declaring
  **`'upstreams'`** (the built-in proxy module) gets the workspace's
  upstreams for its `upstreams` key (registered, secret set — never the
  value or base URL) with assign / unassign, the `call` rule and
  `rateLimit`;
- **the secrets** the module declares: write-only. The page shows the name,
  the description, `required`, whether it is set and when — never the value.
  Set / Rotate / Remove (`setModuleSecret` / `deleteModuleSecret`, audit
  `module.secret_set` `{ module, name, rotated }` / `module.secret_remove`).
  A stored value is followed by a redirect, so it appears in no response;
- **About this module**: version, availability and the modules it
  requires; under a collapsed "Technical details" the source (`builtin` /
  `dir`), the declared contract range, the dedicated editor it declares,
  the slots it offers (and who contributes) and its contributions to other
  modules' slots; a link to the workspace Modules page; then **its error
  codes** (code, meaning, fix), collapsed too.

Viewers see all of it without a single control; every POST needs the editor
role (viewer → 403).

#### Choices of a config field (`x-drobek-choices`)

A string field of a `configSchema` that names something existing — an
upstream, a data collection, a schedule — gets a select in the form when it
carries the JSON Schema keyword `x-drobek-choices` (zod `.meta()`, typed by
`ConfigFieldMeta` from `@drobek/modules`):

```ts
import { z, type ConfigFieldMeta } from '@drobek/modules';

const source = z.strictObject({
  upstream: z.string().meta({ title: 'Upstream', 'x-drobek-choices': 'upstreams' } satisfies ConfigFieldMeta),
  collection: z.string().meta({ title: 'Collection', 'x-drobek-choices': 'collections' } satisfies ConfigFieldMeta),
  every: z.string().default('1h').meta({
    title: 'Schedule',
    'x-drobek-choices': 'intervals',
    'x-drobek-min-interval': 'HELLO_MIN_INTERVAL_MIN',
  } satisfies ConfigFieldMeta),
});
```

| `x-drobek-choices` | The select offers |
| ----- | ----- |
| `upstreams` | the upstreams registered in the app's workspace: those assigned to the app first ("Assigned to this app"), then the rest ("Not assigned to this app yet", with a note and a link to the module declaring `dashboard.editor: 'upstreams'`, where an upstream is assigned) |
| `collections` | the app's data collections — the `collections` of the module declaring `dashboard.editor: 'collections'` |
| `intervals` | `5m`, `10m`, `15m`, `30m`, `1h`, `3h`, `6h`, `12h`, `24h` ("every 15 minutes"), none shorter than the workspace's value of the module limit `x-drobek-min-interval` names (the minimum itself is offered when it is not on the list) |
| `forms` | the app's forms — those with stored submissions or settings, each with its number of submissions ("contact — 3 submissions"), from the module declaring the `submissions` authority |

- A current value that is not among the choices stays selected, marked
  ("gone — not registered in this workspace", "2h — the current value"),
  so saving the form never changes it by accident.
- Nothing to choose and no value yet: the form shows no select but what to
  set up first, with a link — the workspace's Upstreams page, or the
  module that creates collections.
- A list that cannot be loaded leaves a text field with a note.
- On a record's key schema (`z.record(z.string().meta({ 'x-drobek-choices':
  'forms' }), …)`) the list only suggests a name for the new entry: the
  names no entry uses yet, in a list on the name input and in words under
  it ("Suggested: newsletter (1 submission)"); any other name can still be
  typed. `forms` uses it: the form-name entry suggests the forms that
  received submissions but have no settings yet.
- The keyword is presentation only: `configure_module`, the dashboard's save
  and the `configSchema` validate the same with or without it, so an agent
  may still set a value outside the choices. An unknown source, a
  non-string field or an enum ignore it; the lists are found by
  capability, never by a module's name.

#### How a config field is shown

More `ConfigFieldMeta` keywords change how the form shows a field and reads
it back — never what the `configSchema` accepts, so `configure_module`
validates the same. A field the form shows unchanged saves unchanged.

```ts
import { isValidRule, z, type ConfigFieldMeta } from '@drobek/modules';

const rule = z.string().refine(isValidRule, 'a rule like "user|admin"');

const config = z.strictObject({
  rules: z.strictObject({
    upload: rule.default('user').meta({ title: 'Who may upload', 'x-drobek-rule': ['public', 'user', 'admin'] } satisfies ConfigFieldMeta),
    read: rule.default('user').meta({ title: 'Who may download', 'x-drobek-rule': true } satisfies ConfigFieldMeta),
  }),
  maxBytes: z.int().min(1).optional().meta({
    title: 'Largest file',
    'x-drobek-unit': 'bytes',
    'x-drobek-default-limit': 'HELLO_MAX_BYTES',
  } satisfies ConfigFieldMeta),
  paused: z.boolean().optional().meta({ 'x-drobek-hidden': true } satisfies ConfigFieldMeta),
  provider: z
    .strictObject({ issuer: z.string().optional(), enabled: z.boolean() })
    .meta({ 'x-drobek-order': ['enabled'] } satisfies ConfigFieldMeta),
});
```

| Keyword | On | The form |
| ----- | ----- | ----- |
| `x-drobek-rule` | a rule string (`public`, `user`, `owner`, `admin`, `none`, alternatives joined with `\|`) | one checkbox per principal — Anyone, Signed-in users, Record owner, App admins — like the collections editor; rule fields next to each other share one table, a row each with the rule in force. Nothing checked saves `none`. `true` offers all four, a list only those (a principal the current rule names is offered too). A rule saved untouched keeps its exact text (`admin\|user` stays `admin\|user`); a changed one is written in the column order |
| `x-drobek-unit: 'bytes'` | a number | entered in MB (1 MB = 1,048,576 bytes, decimals allowed) and saved as whole bytes; the bounds read in MB ("At most 1024 MB.") and a value outside them is refused at the field in MB. A value that is not a whole number of MB shows exactly, so it saves unchanged |
| `x-drobek-default-limit` | any field | the env name of one of the module's `limits` that applies while the field is empty: the hint says the workspace's value ("Left empty: 10 MB, the limit in force.") |
| `x-drobek-hidden: true` | any field | not shown: a hidden input carries the current value through a save, so the form never changes it — for a key the page sets with a control of its own (`sync`'s Pause / Resume). Agents set it with `configure_module` as before |
| `x-drobek-order` | an object | the listed keys first, in that order; the others follow in the schema's order — e.g. a switch before the fields it turns on, where `.extend()` put it last |

The built-in modules use them: `files` shows `rules.upload` / `rules.read`
as checkboxes (upload without Record owner — the uploader is the owner) and
`maxBytes` in MB with `FILES_MAX_BYTES` as what empty means; `sync`'s
`paused` is hidden (Pause schedule / Resume schedule under Sources set
it); every `auth` sign-in provider shows its On switch first.

### The workspace Modules page

`/workspaces/<ws>/modules` (the workspace's **Modules** tab, every member —
viewer+, read-only) lists every active module of the server: name, version,
source (`builtin` — a package of the server; `dir` — installed by the
operator), the contract range it declares, availability, the modules it
requires, the slots it offers with their contributors (and the unique
value of each contribution), its own contributions, the limits it declares
with the value in force for this workspace (the limits provider's plan,
else the server's env / default) and its error codes. Never a path on disk,
never a secret. The facts come from `ModuleRuntime.moduleFacts()`; agents
get the same fields from `skill_info('<name>')`. An
[operator-only module](#operator-only-modules) is listed for super-admins
only, its card marked operator-only (`operatorOnly` in the facts) and
named among the contributors of the slots it contributes to; the other
members never see it, not even there.

The page leads with a search (`?q=`, every word must appear in the name,
the `dashboard.title` or `description`, "use when", a slot or a limit name
— a GET form, no client JS) and a jump list. Each card is headed by the
module's title and name ("Scheduled imports (sync)") and shows what the
module is for, its version, availability
and requirements; the limits and the technical facts (source, contract,
slots, contributions, error codes) are collapsed sections. A limit's value
is shown in human units read from its env name or meaning (`…_BYTES` /
`…QUOTA…` → `10 MB`, `…_MS` → `1 min`) with the exact value and unit
underneath (`10,485,760 bytes`); a count is shown as is.

An opt-in module's card also shows its state for this workspace — enabled
or not, and what decides it (the plan, the env, or a super-admin's switch),
the required modules still off for it and the enabled modules that depend
on it —
and, for a super-admin only, the Enable / Disable switch
([Per-workspace enabling](#per-workspace-enabling-opt-in-modules)). The
switch is mounted through `<WorkspaceModules availabilityControls={…}>`
(`workspace-modules-toggle.tsx`); its POST answers every non-super-admin
403.

## Skills: `skill_info`

`skill_info` (MCP, scope `read`) is how an agent learns a backend when it
needs one:

- `skill_info()` → `{ skills: [{ name, use_when }] }`. The same list is in
  `create_app` and `get_app` (`skills`) and in the briefing;
- `skill_info('<name>')` → `{ name, kind, use_when, content }`, and for a
  module also `sdk { import, types }`, `config { schema (JSON Schema),
  defaults, confirm_required }`, `limits [{ name, value, meaning }]`,
  `secrets [{ name, description, required }]`, `errors [{ code, meaning,
  fix }]` (its own codes, `[]` when none), `availability`, and the facts the
  workspace Modules page shows: `version`, `source` (`builtin` / `dir`),
  `contract` (the declared range, `null` when none), `requires`, `slots
  [{ name, description, unique, contributions [{ module, key }] }]` and
  `contributes [{ slot, host, key }]`;
- an unknown name → `not_found` with `available` and `hint: "skill_info()"`.

It never returns a secret value or any app's config.

Two sources feed one list:

- **module skills**: every active module's `skill` (an
  [operator-only module](#operator-only-modules) has none and is not listed);
- **general skills**: `skills/<name>/SKILL.md` with frontmatter `name` and
  `description` (the description is the "use when …" sentence). The directory
  is `DROBEK_SKILLS_DIR`, else `<cwd>/skills` (the image copies the repo's
  `skills/`), else `<cwd>/../../skills` (the dev server).

`skills/drobek` is **not** listed: it is the platform skill an agent installs
to reach drobek at all, and its rules are already in the briefing. On a name
clash a module skill wins.

Errors point back at the skills: module route errors carry
`hint: "skill_info('<module>')"`, and a compile error on a backend import
(`firebase`, `@supabase/supabase-js`, …) carries `skill_info('<skill>')` when
a matching skill is active, else `skill_info()`.

Every drobek skill states the rule (`SKILL_INFO_RULE` in `@drobek/agent-dx`)
verbatim:

> Before using a backend (login, stored data, forms, email, file uploads,
> external APIs), call `skill_info` and follow the skill; `create_app`/`get_app`
> list the available skills.

The repo ships four general skills: `start` (how an app works: files,
`drobek.json`, the write_files → compile → preview → publish loop, the lease,
what the server never runs), `debug` (reading `compile.errors` and
`get_logs`, typical causes and fixes), `ui` (Tailwind v4's browser build
from esm.sh, responsive layout, the accessibility minimum, forms and
loading/error states) and `port-artifact` (moving a Claude artifact to
drobek: text files unchanged with `write_files`, every binary through
`create_asset_upload` at the same path, what the app CSP changes, no
`window.claude.*`). With every built-in module enabled `skill_info()` lists
12 skills: `auth, email, forms, data, proxy, files, sync, oidc, debug,
port-artifact, start, ui` (plus `hello` and the opt-in `acmecrm` in the dev
stack).

### The skill format (NSO-308)

Skills are written for the agent only: terse, code first, exact API names,
no marketing. Every skill — built-in module or general — has at most 150
lines (frontmatter included) and exactly these `##` sections under one
`# <name> — <what it is>` title:

1. `## 1. When to use` — the situation, and what NOT to use instead;
2. `## 2. Minimal working code` — a complete `src/main.tsx` (or page) that
   works as written, plus the `configure_module` payload it needs;
3. `## 3. API and types` — the SDK as ```` ```ts api ```` declaration blocks
   (first line `// drobek.<module>` or `// drobek/<module>`), config keys;
4. `## 4. Rules and limits` — what the server enforces (confirmations,
   limits by env name and default);
5. `## 5. Errors → fix` — a table `| error | cause | fix |`; a backticked
   code in the first column must exist in the error catalogue, the module's
   `errors` or those of a module it `requires`.

`checkSkill(module)` from `@drobek/modules/testing` enforces the format
(and a one-sentence "use when" of 30–220 characters) and that the code does
not rot. The repo gate `@drobek/skills-check` (part of `task check`) runs
the same library over the built-in modules and the general skills; an
external module runs it in its own tests ([Writing a module](#writing-a-module)).
Every fenced block is checked by its info string —
`tsx`/`ts`/`jsx`/`js` are compiled with `@drobek/compile` exactly like
`write_files` (the skill's import map, the SDK, the inline sources, the
secret scan) AND typechecked with the TypeScript compiler against the
generated `sdk.d.ts` + the inline declarations + `@types/react` (esbuild
only strips types); `ts api` blocks must be mutually assignable to the real
declarations; `json` blocks must parse, a `configure_module` payload
(`module` + `config`) must pass the module's schema over its defaults, and
```` ```json drobek.json ```` sets the import map for the skill's following
blocks; `html` is compiled and its `<script src>` must satisfy the apps CSP;
`css` is compiled; `sh`/`text` are prose; a block without a language fails.
A module skill needs a `ts api` block per import it offers and one
`configure_module` payload — of the module itself or of a module it
`requires` (a sign-in provider shows the auth config). A failure names the SKILL.md line, the skill and
the block. The e2e module specs run the FIRST ```` ```tsx ```` block of a
module skill as a live app — keep its visible texts stable.

The agent-level eval (does a fresh agent build working apps from these
skills?) is `tests-eval/` (`task eval`, manual, not CI).

## Limits and the limits provider

Every limit is its env var (`HELLO_WAVES_PER_MINUTE=5`) or the module's
default. Besides every active module's `limits`, the catalogue holds the
**core limits** (which core enforces itself and a module may not declare):

| Name | Default | Semantics |
| --- | --- | --- |
| `APPS_MAX_PER_WORKSPACE` | 50 | live apps one workspace may hold (soft-deleted apps do not count); `create_app` beyond it answers `limit_exceeded` with `limit` / `value` |
| `DOMAINS_MAX_PER_APP` | 3 | custom domains per app, pending + verified; the next add answers `limit_exceeded`. `0` is valid and turns custom domains off: the dashboard's Domains tab says so and every add is refused |
| `UPSTREAMS_MAX_PER_WORKSPACE` | 20 | proxy upstreams one workspace may hold; `register_upstream` and the Upstreams page beyond it answer `limit_exceeded` with `limit` / `value` (existing upstreams over a lowered limit stay) |
| `APP_ASSET_MAX_BYTES` | 104857600 | bytes of one app asset (100 MiB — video, audio, image, font at `/<path>`); `create_asset_upload` / the upload URL answer `asset_too_large` |
| `APP_ASSETS_QUOTA` | 1073741824 | bytes of all assets of one app (1 GiB); past it `asset_quota_exceeded` |
| `VERSIONS_PER_APP_HOUR` | 600 | new versions of one app within the last hour — `write_files`, `create_app`, `restore_version`, `duplicate_app` and the dashboard's Restore together; past it `rate_limited` with `limit` / `value` / `retry_after_seconds`, nothing stored |
| `VERSIONS_PER_USER_HOUR` | 1200 | new versions one person makes within the last hour, in every app and workspace (the plan of the workspace being written applies); past it `rate_limited` like above |
| `APP_VERSIONS_KEEP` | 200 | the newest versions of each app the hourly history retention keeps; older ones are deleted, except the published one, those kept for a rollback, the one the preview serves and those from the last hour. While the provider does not answer for a workspace, the retention leaves it alone |
| `WORKSPACE_SOURCE_QUOTA` | 1073741824 | bytes of the unique files (sources and build output) the versions of a workspace's live apps store (1 GiB); a version whose new bytes do not fit answers `limit_exceeded` with `limit` / `value` / `used_bytes`, nothing stored |

`ModuleRuntime.workspaceLimits(workspaceId)` returns a workspace's effective
limits (core and module) for core callers. An operator with plans sets:

```sh
LIMITS_PROVIDER_URL=https://billing.internal
LIMITS_PROVIDER_SECRET=<openssl rand -hex 32>   # ≥ 32 characters; required with the URL
```

drobek then asks, per workspace:

```
GET <LIMITS_PROVIDER_URL>/limits/<workspace_id>
X-Drobek-Timestamp: <unix seconds>
X-Drobek-Signature: v1=<hex HMAC-SHA256(LIMITS_PROVIDER_SECRET, "<ts>.GET./limits/<workspace_id>")>
```

and expects `{ "limits": { "<ENV_NAME>": <positive integer>, … } }` (`0`
too for `DOMAINS_MAX_PER_APP`). Known names override the env defaults; unknown
names and bad values are ignored. A provider mirrors the table above plus the
`limits` of the modules the server runs (`skill_info(<module>).limits`).
For every opt-in module the catalogue also holds the pseudo-limit
`MODULE_ENABLED_<NAME>` (`0` or `1`, env default `0`): a plan maps to it to
enable (`1`) or disable (`0`) that module for the workspace — see
[Per-workspace enabling](#per-workspace-enabling-opt-in-modules). The
protocol is the same; a value other than `0` / `1` is ignored.
Answers are cached in Redis for 60 s (`drobek:limits:<workspace_id>`). When
the provider is down, slower than 2 s or answers garbage, the env defaults
apply for 10 s and a warning is logged: a provider outage never takes apps
down.
The server refuses to start with a URL but a missing or weak secret.

## Testing a module

`@drobek/modules/testing` runs routes through the **same pipeline**
production uses, without a server, Redis or SMTP:

```ts
import { createModuleTestContext } from '@drobek/modules/testing';
import hello from './index.js';

const t = createModuleTestContext(hello, {
  db,                                   // e.g. PGlite with the core + module migrations
  app: { id: appId },
  config: { greeting: 'Ahoj' },         // merged over configDefaults, validated
  secrets: { HELLO_SIGNATURE: 'k' },
  limits: { HELLO_WAVES_PER_MINUTE: 1 },
  principal: { kind: 'user', id: 'u1', email: 'a@example.com', role: 'user' },
});
const res = await t.request('POST', '/wave', { body: { name: 'Ada' } });
expect(res).toMatchObject({ status: 200, body: { waves: 1 } });
t.audits;   // [{ action: 'hello.…', meta }]
t.emails;   // [{ to, subject, text, kind, fromName?, replyTo? }] (owners: ['…'] feeds { appOwners: true })
t.setPrincipal({ kind: 'anon' });
await t.confirm({}, { greeting: 'Ahoj' });   // confirmRequired over two config patches → ['greeting: …']
await t.runJob('refresh');                   // one run of a scheduled job → { ran, intervalMs }
```

Mutating requests send the app's `Origin` and `X-Drobek-SDK: 1` by default;
pass `headers` to test the CSRF guard. `contributions: { '<slot>': [value, …] }`
sets what `ctx.contributions(slot)` returns. A response's list-valued
header is joined with `, ` in `headers`; `setCookies` lists every
`Set-Cookie` apart. `request()` rejects where
production answers `500 internal_error`: an exception that is not a
ModuleError, or a ModuleError with a code that is neither core nor in the
module's `errors`. `runJob(name, { signal?, lastSuccessAt? })` runs one of
the module's `jobs` once: an `app` job for the test app with the test config,
secrets and limits (`{ ran: false }` when its `every(config)` gives no
interval), a `server` job with `apps()` yielding the test app; it rejects
with the job's own error.

The database for `db` needs no other drobek package:

```ts
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { checkSkill, coreMigrationsDir, createTestApp, formatSkillIssue } from '@drobek/modules/testing';

const d = drizzle(new PGlite());
await migrate(d, { migrationsFolder: coreMigrationsDir(), migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
await migrate(d, { migrationsFolder: hello.migrations!.folder, migrationsTable: '__drizzle_migrations_mod_hello', migrationsSchema: 'drizzle' });
const app = await createTestApp(d);            // a workspace + an app row → { id, slug, workspaceId }

expect((await checkSkill(hello)).map(formatSkillIssue)).toEqual([]);   // the SKILL.md gate
```

`coreMigrationsDir()` is the core migrations folder (`packages/db/drizzle/migrations`
in this repo, a copy inside the published package). `checkSkill(module,
{ modules?, file?, root? })` returns the issues of the module's skill:
`modules` adds other modules whose SDK the examples use (e.g. the `auth`
module for `drobek.auth`; the set is composed like a server's, so a sign-in
provider's `configure_module('auth', { providers: { <id>: … } })` payload
passes), `root` is the directory whose `node_modules`
resolve the examples' bare imports (default: the working directory; an
unresolved one is typed `any`). It needs `typescript` installed (an
optional peer dependency).

## Writing a module

A module outside this repository is an npm package written against the
published contract. Every drobek release publishes, with the image's
version, three npm packages: **`@freema/drobek-modules`** (the public
contract and the test kit, see [Public API and semver](#public-api-and-semver)), **`@freema/drobek-sdk`** (the browser
`SdkCore` a module's SDK entry receives) and **`create-drobek-module`**
(the scaffold). All three are AGPL-3.0-only, like the rest of drobek
([`LICENSING.md`](./LICENSING.md) → Modules).

Module code imports them as `@drobek/modules` (and
`@drobek/modules/testing`) and `@drobek/sdk`: a module installs the
published packages under those names with an npm alias, which is what the
scaffold writes:

```sh
npm install --save-dev @drobek/modules@npm:@freema/drobek-modules@^X.Y.Z
# only when the module imports @drobek/sdk itself (@drobek/modules re-exports SdkCore):
npm install --save-dev @drobek/sdk@npm:@freema/drobek-sdk@^X.Y.Z
```

```json
{
  "peerDependencies": { "@drobek/modules": ">=X.Y.Z", "drizzle-orm": ">=0.45.0" },
  "devDependencies": { "@drobek/modules": "npm:@freema/drobek-modules@^X.Y.Z" }
}
```

The peer stays on `@drobek/modules`: that is the name the server's
installer checks and the server provides.

### Scaffold

```sh
npm create drobek-module@latest erp        # → drobek-module-erp/, the module "erp"
cd drobek-module-erp && npm install && npm test
```

`<name>` is a short name (`erp` → the package `drobek-module-erp`), a full
`drobek-module-<x>` or a scoped package (`@acme/drobek-module-erp`). The
module name is the package name without `drobek-module-` and dashes
(`acme-erp` → `acmeerp`; `--module <name>` sets it). The output is a working
module: `src/index.ts` (`defineModule` with `contract: '^1.1'`, config with
an owner confirmation, a secret, a limit, an own error code, a GET/POST pair
of routes), `src/sdk.ts`, `src/schema.ts` + `migrations/0000_init.sql` (the
table `mod_<name>_items`), `SKILL.md`, `src/index.test.ts`
(`createModuleTestContext` over PGlite with the core migrations),
`src/skill.test.ts` (`checkSkill`) and a README with the install steps.
Scripts: `build` (tsc → `dist/`, also run by `prepack`), `typecheck`, `test`,
`check` (the skill gate alone). [`examples/drobek-module-hello`](../examples/drobek-module-hello)
is the scaffold's output plus the slot demo.

### Contract and peers

- `contract` is a semver range against the server's `MODULE_CONTRACT_VERSION`;
  a server whose version does not satisfy it refuses to start. Declare the
  lowest contract whose fields the module uses (`'^1.1'` for `errors`,
  `slots`, `contributes`, `availability`, `dashboard`, `onAppDelete`;
  `'^1.2'` for `jobs`).
- `@drobek/modules` and `drizzle-orm` are **peer dependencies** (and dev
  dependencies for the tests — `@drobek/modules` through the npm alias);
  `zod` comes as `z` from `@drobek/modules`.
  On a server the module uses the server's instances — never bundle them:
  a second copy of the contract breaks the brand checks (`isModuleError`).
- Everything a module needs is exported by `@drobek/modules`
  (`defineModule`, `z`, `respond`, `ModuleError`, the types incl. `DB`,
  `Logger`, `SdkCore`, `HookApp`); the published declarations name no
  private drobek package.
- The module is operator-installed server code with the whole database
  (`ctx.db`). It keeps to its own tables (`mod_<name>` / `mod_<name>_*`,
  foreign keys only to `apps(id)` / `workspaces(id)`), never alters another
  table, never reads secrets of other modules, and never executes app code.

### Public API and semver

`@freema/drobek-modules` publishes two entry points, and they are its whole
public API:

- `@drobek/modules`: the contract. `defineModule` and the slot helpers
  (`defineAuthProvider`, `defineSignInObserver`, `defineEmailTransport`),
  `z`, `respond`, `ModuleError` and the error helpers, the rule helpers,
  `perIpLimitKey`, the byte-sniffing helpers, the contract constants and
  every type a module names (`ModuleContext`, `HookApp`, `DB`, `Logger`,
  `SdkCore`, the limit and error types, …);
- `@drobek/modules/testing`: the test kit. `createModuleTestContext`,
  `createTestApp`, `coreMigrationsDir`, `checkSkill` with the skill-check
  helpers, `memoryMailGuard`, and `loadModules` / `buildSdk` (the server's
  loader and SDK build, to assert that the module loads next to others and
  its SDK slice builds).

The runtime, the registry and loader, the limits provider, end-user
sessions and the secret and config storage are internal to the server and
not published. The contract entry never imports them (a test walks its
import graph), the examples and the scaffold import only these two entries,
and the published declarations of both are snapshotted in the repository
(`packages/create-drobek-module/src/__snapshots__/`), so every change to
the API shows in review.

The package version is the drobek release version, and semver applies to
this API:

- **breaking**: anything that can stop a module that compiled and passed
  its tests from doing so — removing or renaming an export, a required
  field or parameter added, a parameter type narrowed or a return type
  widened, a documented behaviour changed, a new major
  `MODULE_CONTRACT_VERSION`. It needs a new major version; while drobek is
  `0.x`, the minor plays that part (`^0.Y.Z` never crosses it);
- **additive**: a new export, an optional field or parameter, a new error
  code, a contract minor (`1.1` → `1.2`). A minor version, or a patch
  while drobek is `0.x`;
- **patch**: no change to the declarations.

A deprecated export keeps working until the next breaking version and is
marked `@deprecated` in its declaration: `loadModules` and `buildSdk`
imported from `@drobek/modules` (use `@drobek/modules/testing`).

### Publish

Publish to npm (`npm publish`; `prepack` builds `dist/`) or ship the
tarball `npm pack` writes (`drobek-module-erp-0.1.0.tgz`) from any URL. The
package contains `dist/`, `migrations/` and `SKILL.md`. A git URL works
only with a committed `dist/` (installs run without lifecycle scripts).
Keep the keyword `drobek-module` in `package.json` (the scaffold sets it):
[www.drobek.app/modules](https://www.drobek.app/modules) lists every npm
package with it under "Community modules", marked not reviewed, refreshed on
each deploy of the site.

### Install on a server

The operator installs the package — any spec `npm install` accepts (a
registry version, a tarball URL, a git URL) — with
`task selfhost:module:add -- <spec>` ([`SELF-HOSTING.md`](./SELF-HOSTING.md#third-party-modules)),
then adds its entry to `DROBEK_MODULES` (the short name when the package is
`drobek-module-<name>`, else the full package name) and restarts drobek.
The start refuses a module whose `contract` range does not match. An
operator with an own image build can instead add the package as a
dependency of the server (see [Enabling modules on your server](#enabling-modules-on-your-server-operators)).

### Compatibility

The [external-consumer check](ECOSYSTEM.md#external-consumer-check) tests a
pinned counter module against candidate core packages before release.

| Module contract (`MODULE_CONTRACT_VERSION`) | drobek image / npm packages | A module declaring |
| --- | --- | --- |
| `1.0.0` | v0.1.0 – v0.1.4 | `'^1.0'` (or no `contract`) |
| `1.1.0` | v0.2.0 – v0.5.x | `'^1.1'` or `'^1.0'` |
| `1.2.0` | v0.6.0 – | `'^1.2'` (a module with `jobs`), `'^1.1'` or `'^1.0'` |

`@freema/drobek-modules@X.Y.Z` is the contract of the image `ghcr.io/freema/drobek:vX.Y.Z`
(both come from one tag). Additive contract changes raise the minor version
(`1.1` → `1.2`): a module declaring `'^1.1'` keeps loading. A breaking
change raises the major, and such a server refuses `'^1.x'` modules with a
message naming both versions. The server logs the version at start
(`platform modules ready`, `contract`).

A sign-in provider has its own compatibility boundary besides `contract`:
the auth provider API it declares in its `auth.provider` contribution as
`apiVersion` (`AUTH_PROVIDER_API_VERSION`, now `2`). API 2 requires
`callback()` to return the verified `issuer`. A provider written before
that declares no `apiVersion`, and the server refuses to start with it —
`module "<name>": its contribution to the slot "auth.provider" (module
"auth") does not pass the slot's schema — apiVersion: missing — …` — instead
of failing each sign-in with `provider_error`. To migrate a provider,
return the `issuer` it verified (OIDC: the `iss` of the validated ID token;
SAML: the assertion's Issuer), add `apiVersion: 2` next to its `id`, and
publish a new version. The module's `contract` range stays as it is
(`'^1.1'` keeps loading); modules without an `auth.provider` contribution
are not affected.

### Published modules

Modules anyone can install with `task selfhost:module:add -- <spec>`, also
listed in the directory at [www.drobek.app/modules](https://www.drobek.app/modules).
An npm package with the `drobek-module` keyword appears there under
"Community modules" on its own; to have it reviewed and listed in the
directory, fill in the [module submission form](https://github.com/freema/drobek/issues/new?template=module-submission.yml):
the package on npm (or a tarball URL), what it does, the contract it declares,
its license and where its source is.

| Package | What it does | Contract | Source |
| --- | --- | --- | --- |
| `drobek-module-hello` | the scaffold's output plus the slot demo — a starting point, not for production; not on npm, install it from a tarball `npm pack` writes in the example | `^1.1` | [`examples/drobek-module-hello`](../examples/drobek-module-hello) |
| `drobek-module-acme-crm` | an opt-in example (module `acmecrm`): contacts per app, one written on every end-user sign-in through the `auth.signedIn` slot; not on npm, install its `npm pack` tarball with `selfhost:module:add` | `^1.2` | [`examples/drobek-module-acme-crm`](../examples/drobek-module-acme-crm) |
| `drobek-module-counter` | named counters per app (page views, likes, downloads): `drobek.counter.hit(key)` / `get(key)` / `list()`, per-IP and per-app hit limits, `maxKeys`; on npm as `drobek-module-counter` (`task selfhost:module:add -- drobek-module-counter@<version>`), each version also as a tarball on its [GitHub release](https://github.com/freema/drobek-module-counter/releases) | `^1.1` | [`freema/drobek-module-counter`](https://github.com/freema/drobek-module-counter) |

## End-user sessions (core)

The end-user session belongs to core (`@drobek/modules`), not to a module, so
every module sees the signed-in user as `ctx.principal` without importing the
auth module:

- the cookie: `__Host-drobek_eu` (`drobek_eu` in plain-http dev), host-only
  (no `Domain`), `Path=/`, `HttpOnly`, `SameSite=Lax`, `Secure` in production
  or when the apps origin is https; the value is 64 hex characters;
- the record: Redis `drobek:eu:<app_id>:<token>` →
  `{ id, email, role, epoch, provider? }`, 30 days, rolled forward by the
  auth module's `me`; `provider` is the sign-in method the session was made
  with (`email` or a sign-in provider id) and reaches `endUsers.current` as
  `user.provider`;
- the app's epoch `drobek:eu-epoch:<app_id>`: a session whose epoch differs is
  dead. Raising it signs every user of the app out on every host of the app
  (preview, production, version hosts);
- the app purge (`APP_PURGE_AFTER_DAYS` after a delete) removes the app's
  session records and its epoch (`forgetEndUserSessions`, one `SCAN` pass per
  run), after the user rows went with the app;
- **the record is never the principal on its own**: for every module request
  that carries a live session, core asks the module that owns end-user
  sessions (`endUsers.current`, the auth module) who the user is NOW, with
  the app's current config. `null` (disabled, deleted, no longer allowed) →
  the request is anonymous and the session is deleted; otherwise the
  principal carries the user's CURRENT role. There is no cache: a change
  applies to the next request to any module, whether or not the app calls
  `me`. A failing lookup makes that request anonymous (fail closed). At most
  one active module may declare `endUsers` (two refuse the start); with none,
  no session is honoured;
- `endUsers.callback` (optional): the IdP callback of end-user sign-in
  providers, `GET|POST /__drobek/auth/callback/:provider` on the DASHBOARD
  host (`runtime.endUserCallback`, see "Auth providers" below). Core hands
  it the query, a urlencoded POST body (≤ 256 KiB), the client IP and
  services: a callback-namespaced rate limiter, the server's default
  limits, and `app(id)` — a live app (not deleted, not taken down) with the
  authority's effective config, its declared secrets and an audit writer.
  It answers `{ kind: 'redirect', location }` or `{ kind: 'page', status,
  title, message, link? }`; a throw is a generic 500 page;
- helpers: `createEndUserSession`, `loadEndUserSession`,
  `renewEndUserSession`, `destroyEndUserSession`, `revokeEndUserSessions`,
  `forgetEndUserSessions`,
  `endUserCookieHeader`, `readEndUserToken`, `cookiePrincipalResolver({
  redis, secure, current })` (fails closed: any Redis error is an anonymous
  visitor).

Preview and production are different hosts, so a session never crosses them;
the users (rows) are per app and shared by both.

### Signing every user out: `POST /api/apps/:app_id/end-user-sessions/revoke`

The owner's dashboard API (no MCP tool: the owner decides, never an agent).
The same guards as the confirm API: POST only (`405`), a dashboard session
(`401`), a **required** dashboard `Origin` (`403`), editor or workspace-admin
of the app's workspace or a super-admin; a missing app and a non-member both
get `404 not_found`, a viewer `403`. It raises the epoch and answers `{ ok:
true, app_id, epoch }`; audit `end_users.sessions_revoke` (actor user).

## The built-in `auth` module

[`modules/auth`](../modules/auth) (`drobek-module-auth`): the people who use
an app sign in with a 6-digit code e-mailed to them. Its `SKILL.md` is what
`skill_info('auth')` returns.

- **Routes** (`/__drobek/v1/auth/…`, all `public`, CSRF `sdk-header`):
  `POST send-code { email }`, `POST verify { email, code }` → `{ user }` +
  the session cookie, `GET me` → `{ user | null }` (+ rolls the session and
  its cookie), `POST logout`, `GET providers` → `{ providers: [{ id, label
  }] }` (the methods that are on), `POST begin { provider, return_to? }` →
  `{ url }` and `GET complete?code=` (provider sign-in, below).
- **Config** `{ allow: { emails, domains, anyone }, adminEmails, providers
  }`: exact addresses (lowercased), exact domains, and `anyone: true`, which
  **needs the owner's confirmation**. `adminEmails` may sign in and get the
  role `admin`. The editors and workspace-admins of the app's workspace may
  always sign in with their own address, as `admin` (the preview works
  before any config); viewers may not. `providers` (below) turns the sign-in
  methods on and off.
- **Tables** `mod_auth_users (id, app_id, email, role, verified_at,
  last_login_at, disabled_at, created_at, provider)`, unique `(app_id,
  email)`; `provider` is `email` or the sign-in provider the user is linked
  to. `mod_auth_identities (id, app_id, user_id, provider, issuer, subject,
  created_at, last_login_at)` — who a provider proved, bound to one user:
  unique `(app_id, provider, issuer, subject)` and `(user_id, provider)`;
  `issuer` NULL marks an identity linked before issuers were recorded (auth
  migration 0002 moved the 0001 subjects there; see [Auth
  providers](#auth-providers)). Both cascade on app delete, identities also
  with their user. A user with `disabled_at` cannot sign in, and their next
  `me` signs them out.
- **Codes**: the dashboard login's own machinery from `@drobek/auth`
  (`createEmailLoginCode` / `consumeEmailLoginCode`, the atomic guess counter
  of PHY-76 #1, the OTP guard layers) with the scope `eu:<app_id>`: keys
  `drobek:otp:eu:<app_id>:…`, rate-limit buckets `drobek:rl:eu:<app_id>:…`.
  One app's codes, counters and pauses never touch the dashboard's or another
  app's; the operator's kill switch (`OTP_LOGIN_DISABLED`) and the global
  pause still apply. A code lives 10 minutes, works once and dies after 5
  wrong tries (`too_many_attempts`).
- **send-code** checks the allowlist first: an address that may not sign in
  gets `403 email_not_allowed` and no e-mail. Within the per-address cooldown
  and hourly share it answers like a send and sends nothing. The e-mail names
  the app (a one-line, capped name) and goes to `{ signInAddress }`; logs mask
  addresses (`maskEmail`). The per-IP, per-address and per-app code counters
  are only read before the send and charged after the code went out
  (`checkOtpRequest` / `chargeOtpRequest`): an attempt that sent nothing —
  the module e-mail guard refused it (paused, a share used up) or the mail
  transport failed — costs nothing but the route's per-IP attempt limit, so
  a user who retried during a pause or a mail outage gets a code as soon as
  mail works again.
- **verify** decides the allowlist again (it may have changed since the code
  was sent), upserts the user (role from the config), creates the session and
  writes the audit `auth.sign_in` (actor end_user).
- **Who is signed in, now** (`src/current.ts`, the module's
  `endUsers.current`): the session's sign-in method is still on, the
  `mod_auth_users` row exists and is not disabled,
  the current config still lets the address in (allowlist, `adminEmails`, or
  an editor / workspace-admin of the app's workspace), and the role follows
  the config. Core runs it for every module request with a session (two
  indexed lookups), so a user who is disabled, deleted, dropped from the
  allowlist or `adminEmails`, or an editor removed from the workspace, is
  anonymous or demoted in EVERY module on the next request.
- **me** makes the same decision, and also writes a changed role back to the
  row, rolls the session forward and clears the cookie of an ended session.
- **Limits** (per app): `AUTH_CODES_PER_IP_15MIN` 5, `AUTH_CODES_PER_IP_DAY`
  20, `AUTH_CODES_PER_EMAIL_HOUR` 3, `AUTH_CODES_PER_APP_HOUR` 100 (never
  more than the app's share of the server's sign-in budget,
  `EMAIL_SIGNIN_APP_HOURLY_SHARE` — 25 by default; then the app's sign-in
  e-mails pause for 15 minutes), `AUTH_ATTEMPTS_PER_IP_15MIN` 30
  (send-code, verify, begin and complete calls), `END_USERS_MAX_PER_APP`
  1000; server-wide `AUTH_PROVIDER_CALLBACKS_PER_IP_15MIN` 60 (IdP callbacks
  per client IP on the dashboard host — the app is not known yet, so the
  server default applies, never a workspace override).
- **SDK**: `drobek.auth.me() / sendCode(email) / verify(email, code) /
  logout() / onChange(cb) / providers() / signIn(provider, { returnTo? })`
  in `sdk.js`, and the inline source `drobek/auth`: `<LoginGate title
  requireAdmin loading>` (the e-mail form when `emailCode` is on, a
  "Continue with <label>" button per enabled provider) and `useAuth()`,
  React components built into the app with the app's React.
- **Observers**: after every successful sign-in (e-mail code or provider)
  the module tells each `auth.signedIn` contribution — `onSignIn({ app,
  user, provider, isNew, db, log })`, in parallel, each cut off after 5 s;
  a failure is logged (observer id + error name) and never blocks or fails
  the sign-in.

### Auth providers

Other modules add ways to sign in through the auth module's slot
`auth.provider` (`defineAuthProvider` from `@drobek/modules`). A provider
only **proves an identity**; auth keeps the allowlist, roles, users,
sessions and audits. A provider declares `apiVersion: 2` (the auth
provider API it implements, see [Compatibility](#compatibility)); a
contribution without it, or with another value, refuses the server start.

```ts
contributes: {
  'auth.provider': defineAuthProvider({
    apiVersion: 2,                      // AUTH_PROVIDER_API_VERSION: callback() answers the issuer
    id: 'oidc',                         // ^[a-z][a-z0-9]{1,15}$, not "email"
    label: 'Company SSO',               // "Continue with Company SSO"
    configSchema: z.strictObject({ issuer: z.url(), clientId: z.string() }), // no `enabled`
    configDefaults: { },                // optional, must pass configSchema.partial()
    identityFields: ['issuer', 'clientId'], // changing them waits for the owner
    secrets: [{ name: 'OIDC_CLIENT_SECRET', description: '…', env: 'AUTH_OIDC_CLIENT_SECRET' }],
    async begin({ config, secrets, env, redirectUri, state, nonce, codeChallenge }) {
      return { url: '…the IdP authorize URL…' };
    },
    async callback({ query, body, codeVerifier, state, nonce, config, secrets, env }) {
      return { issuer, subject, email, emailVerified, name };  // a VERIFIED identity, or throw
    },
  }),
},
```

**Config.** `providers` holds `emailCode: { enabled }` (default on) and one
entry per `auth.provider` contribution of the server: `{ enabled,
relinkByEmail?, …the provider's configSchema }` (a configSchema may not
declare `enabled` or `relinkByEmail`; the provider gets its config without
them). The schema is composed at start (`compose`):
while a provider is off its fields are optional; enabling it validates the
whole provider schema. Enabling a provider, changing one of its
`identityFields` while it is on, and turning `relinkByEmail` on **need the
owner's confirmation** (the item lists the identity fields); turning a
method off never waits.
`emailCode` off with no provider on is `invalid_params`
(`providers.emailCode.enabled`). A stored config naming a provider the
server no longer runs is salvaged: that entry is dropped (or a broken one
turned off), never the e-mail code switched back on — with nothing on,
nobody can sign in until the owner fixes it. A provider whose configSchema
declares `label` lets each app name its button: `<LoginGate>`,
`drobek.auth.providers()` and the sign-in pages show `providers.<id>.label`
instead of the contribution's `label` (the built-in `oidc`: "Continue with
Acme"). `get_app` → `modules.auth.info.providers` lists every provider of
the server as `{ id, enabled, serverEnv }` — `serverEnv` names the
operator's `AUTH_<ID>_*` variables that are set, never a value; whether the
app has its own secret is `modules.auth.secrets[].hasSecret`.

**Secrets.** A provider's secrets are per-app secrets of the auth module
(set in the dashboard, never through MCP); names start with `<ID>_`. A
provider reads only its own declared names: the app's value first, else
the operator's env var it declared as `env` (`AUTH_<ID>_…`). `begin` and
`callback` also get `env` — the operator's `AUTH_<ID>_*` variables only.

**The flow** (`modules/auth/src/flow.ts`):

```
app host                          dashboard host                        IdP
POST /__drobek/v1/auth/begin ──► (none)
  state id, nonce, PKCE verifier, flow token → Redis drobek:eu-oauth:<id> (10 min)
  state = <id>.<HMAC(app, host, provider, nonce)>, flow cookie (__Host-)
  ◄── { url }  ─────────────────────────────────────────────────────────► authorize
                                  GET|POST /__drobek/auth/callback/<id> ◄──
                                  state: GETDEL + HMAC + provider check
                                  provider.callback() → verified identity
                                  allowlist → upsert / link user
                                  handoff code → Redis (60 s)
GET /__drobek/v1/auth/complete?code= ◄── 302
  code: GETDEL, same app + host, flow cookie hash matches
  decide again → session cookie (host-only) → 302 return_to
```

- the state is `<id>.<HMAC-SHA256>`; the key is HKDF over
  `DROBEK_MASTER_KEY` (label `drobek/eu-oauth-state/v1`); without a valid
  master key provider sign-in answers `unavailable`. The state record
  holds the app, host, provider, nonce, PKCE verifier, `return_to` and the
  SHA-256 of the flow token; it is consumed on the first callback, valid or
  not;
- the app comes **only from the state**; the callback never reads the
  dashboard session or cookie. The redirect URI of provider `<id>` is
  `<PUBLIC_APP_URL>/__drobek/auth/callback/<id>` — one per server, registered
  once at the IdP;
- `return_to` must be a path on the app host (`safeReturnPath`: one leading
  `/`, no `//`, `/\`, scheme or control characters), else `invalid_request`;
- the handoff code (32 random bytes) lives 60 s, works once, and only on the
  app host that began the sign-in, in the browser holding the flow cookie
  (`__Host-drobek_eu_flow`: Secure, `Path=/`, no `Domain`, HttpOnly,
  SameSite=Lax, 10 min; `drobek_eu_flow` on plain-http dev; `complete`
  expires it with the session cookie) — a callback
  link handed to someone else signs nobody in, and another app host under
  `APPS_DOMAIN` cannot plant the cookie: a browser refuses a `__Host-`
  cookie with a `Domain`, and `complete` reads no other name. A sign-in begun
  before a release that changes the state or handoff record answers "Sign-in
  expired" / "Start again";
- a provider identity must be **verified** (`emailVerified: true`), else
  `email_not_verified`; the allowlist and `adminEmails` then decide as for
  the e-mail code. Who the person is: **Identities** below;
- the provider's **connection** — a SHA-256 over its `identityFields` in the
  app's effective config and the operator's `AUTH_<ID>_*` variables (its
  env fallbacks; not the secret ones it declared) — is recorded at `begin`
  and must be the same at the callback and at `complete`: a sign-in in
  flight while the owner changes whose accounts the provider admits answers
  "Start again" (audited `sign_in_denied { reason: settings_changed }`,
  error `invalid_state`);
- complete decides again (allowlist, disabled, the provider still on and
  on the same connection), creates the session with `provider` and
  `connection`, audits `auth.sign_in { provider }` and tells the
  observers. Every refusal is audited `auth.sign_in_denied {
  provider, reason }` and answers a small page with a link back to the app;
- a provider call is cut off after 15 s; its errors are logged by name
  only (a message may quote tokens or IdP answers) and answer
  `provider_error` / a "Sign-in failed" page;
- `begin` answers only `{ url }`: the app host's CSP (`form-action 'self'`)
  forbids posting a form to an IdP, so a SAML provider sends its request
  with the HTTP-Redirect binding; the IdP may POST its answer to the
  callback (urlencoded, ≤ 256 KiB; the dashboard's Origin check exempts
  `/__drobek/auth/callback`).

**Identities.** `callback()` answers `issuer` — the authority that asserted
`subject`, as the provider verified it (OIDC: the validated ID token's `iss`,
whether the issuer came from the app's config or the operator's env; SAML:
the assertion's Issuer). A person is **(provider, issuer, subject)** ([OIDC
Core §5.7](https://openid.net/specs/openid-connect-core-1_0.html#ClaimStability)):
the same subject from another issuer is another person and never inherits a
user or the records it owns. An identity without an issuer is a
`provider_error`. The callback decides, in order:

1. the identity is bound → its user (the address follows the IdP; refused
   when another user of the app has the new one);
2. an identity linked before issuers were recorded (`issuer` NULL, auth
   0001) with this provider + subject → **claimed** for this issuer, only
   when the IdP asserts the user's own address; another address →
   `account_linked` ("Account does not match", `identity_mismatch`);
3. a user with this address and no identity (an e-mail user) → **linked**
   (same id); a user whose only identity is of this provider at another
   issuer → moved to the new identity **only** with `relinkByEmail` (an
   owner-confirmed issuer migration, audited `auth.identity_relinked`; turn
   it off afterwards); any other user with this address → `account_linked`
   ("Account already linked", `linked_elsewhere`) — an account is never
   re-linked by an address alone;
4. else a new user with this identity (within `END_USERS_MAX_PER_APP`).

A user has one identity per provider; linking a second provider to one
account is not offered.

**Sessions.** A session remembers its method and, for a provider, its
connection; turning a method off, or changing the provider's connection
(an identity field or its `AUTH_<ID>_*` variables), ends its sessions on the
next request (`current`); a provider session from before connections were
recorded ends too. The Users tab shows users whose method is off as
`not_allowed`. The e-mail code (while on) works for every user, linked ones
included.

**Testing.** `createModuleTestContext(auth, { contributions: {
'auth.provider': [provider] } })` composes the module; `t.endUserCallback({
provider, query, body })` runs the callback as core does
(`modules/auth/src/providers.test.ts` drives the whole flow with a fake
IdP).

## The built-in `email` module

[`modules/email`](../modules/email) (`drobek-module-email`): the app's mail
policy and a way to reach the app's owners. `skill_info('email')`.

- **Route** `POST /__drobek/v1/email/notify-admins { subject, text }` (rule
  `user`, strict body: subject 1–150, text 1–5000 characters, 8 KiB) →
  `{ sent }`; SDK `drobek.email.notifyAdmins(subject, text)`. The recipients
  are the **app's owners**: the editors and workspace-admins of the app's
  drobek workspace — verified drobek accounts nobody can add through MCP (the
  auth module's `adminEmails` are deliberately NOT used: an agent can change
  them without confirmation). The subject becomes `[<app name>] <subject>`;
  the text names the signed-in user who sent it and the app host.
- **Config** `{ fromName?, replyTo? }`: `fromName` (1–60 characters, no
  control characters or `"<>@\`) applies at once; a new or changed `replyTo`
  **needs the owner's confirmation**.
- **The mail authority** (`mail.prepare`): counts every notification (not
  sign-in codes) against `EMAIL_PER_APP_PER_DAY` (default 50 per app per day,
  `limit_exceeded` past it) and sets `fromName` / `replyTo` on every message
  the app sends — form notifications and sign-in codes included.
- **Limits**: `EMAIL_PER_APP_PER_DAY` 50, `EMAIL_NOTIFY_ADMINS_PER_DAY` 20
  (notifyAdmins calls per app per day; the 21st is `429 limit_exceeded`).
- **Slot** `email.transport` (unique `id`, `operatorOnly`): another e-mail
  provider for the whole server, see below.

### E-mail transports from modules

SMTP and Resend are built into core (`@drobek/email`), so sign-in codes and
invites never depend on an installed module. Any other provider (SES,
Postmark, a company relay, …) comes as a module contributing to the
`email.transport` slot, which the `email` module hosts. The slot is
`operatorOnly`, so the module needs no skill: it is
[operator-only](#operator-only-modules), never shown to agents or app owners:

```ts
import { EmailSendError, defineEmailTransport, defineModule, z } from '@drobek/modules';

export default defineModule({
  name: 'postmark', version: '1.0.0', contract: '^1.2',
  configSchema: z.object({}), configDefaults: {},
  requires: ['email'],
  contributes: {
    'email.transport': defineEmailTransport({
      apiVersion: 1,                // optional; 1 is the transport API this server implements
      id: 'postmark',               // 2–16 lowercase letters and digits; not smtp or resend
      label: 'Postmark',
      secrets: ['POSTMARK_TOKEN'],  // operator env vars, read at start
      async send(msg, { secrets, signal }) {
        const res = await fetch('https://api.postmarkapp.com/email', {
          method: 'POST',
          signal,
          headers: { 'X-Postmark-Server-Token': secrets.POSTMARK_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            From: `"${msg.from.name}" <${msg.from.address}>`, To: msg.to, Subject: msg.subject,
            HtmlBody: msg.html, TextBody: msg.text, ReplyTo: msg.replyTo,
          }),
        });
        if (res.status === 429) throw new EmailSendError('rate_limited', `HTTP ${res.status}`, { status: 429 });
        if (!res.ok) throw new EmailSendError(res.status >= 500 ? 'unavailable' : 'rejected', `HTTP ${res.status}`, { status: res.status });
      },
    }),
  },
});
```

- **Selection.** `EMAIL_TRANSPORT=<id>` makes the contribution with that id
  carry every message of the server: dashboard sign-in codes, workspace
  invites, platform notices and every module's `ctx.email.send`. The server
  refuses to start when no active module contributes the id (the `email`
  module and the transport's module must both be in `DROBEK_MODULES`), when
  a contribution takes the id `smtp` or `resend`, or when two take one id.
  An opt-in transport module still carries the whole server's mail.
- **The message** is what the built-in transports send: `from` (`{ name,
  address }`: `EMAIL_FROM`'s address under a one-line display name), one
  `to` address, `subject`, `text`, `html` and an optional `replyTo`.
- **Secrets** are server-level, never per app: the env var names in
  `secrets` (UPPER_SNAKE) must all be set in the server env or the start is
  refused; `send` gets their values in `ctx.secrets`. They are not module
  secrets of the dashboard, never pass through MCP, and the server never
  logs them.
- **Errors.** `send` resolves once the provider accepted the message. Throw
  an `EmailSendError` (`rate_limited`, `unauthorized`, `rejected`,
  `unavailable`, `timeout`) to keep its code; any other throw becomes
  `unavailable`. Every secret value is redacted from the message the caller
  sees and logs. The callers answer as for SMTP and Resend: the module route
  `503 unavailable`, the sign-in form its "could not be sent" error.
- **Timeout.** A send is aborted after `EMAIL_TRANSPORT_TIMEOUT_MS` (default
  10000): `ctx.signal` aborts and the send fails with `timeout`. The rate
  limits (`OTP_*`, `EMAIL_GLOBAL_*`, the per-app limits) apply above the
  transport, unchanged.

## The built-in `forms` module

[`modules/forms`](../modules/forms) (`drobek-module-forms`, `requires:
['email']`): form submissions stored and e-mailed. `skill_info('forms')`.

- **Routes** (`/__drobek/v1/forms/…`, form names `^[a-z0-9][a-z0-9_-]{0,39}$`):
  - `GET :form/token` (public) → `{ token, min_wait_ms: 2000, expires_in:
    7200 }`: the time token `_t` = `<issued-at>.<HMAC-SHA256>` bound to the app
    and the form, keyed by HKDF(`DROBEK_MASTER_KEY`, `drobek/forms-token/v1`) —
    no separate secret; without the master key forms answer `503`;
  - `POST :form` (rule `rules.submit`: `public` default or `user`; JSON or
    text-only multipart; 32 KiB) → `{ ok: true, id, notified }` (`notified`:
    the notification e-mail went out). In order: the
    honeypot `_hp` — non-empty → answered like a success,
    nothing stored or sent, and a log line `forms_honeypot_drop` with the
    per-app daily counter `dropped_today` (never the values); the token —
    missing/forged/other form/expired → `400 invalid_form_token`
    (`details.reason`), younger than 2 s → `429 submitted_too_fast`
    (`Retry-After`); the fields — a flat object, ≤ 50 fields, strings ≤ 10 000
    characters, finite numbers, booleans, null, lists of ≤ 50 strings; `_`
    names reserved; the limits — `FORMS_SUBMITS_PER_IP_HOUR` (10 per client
    IP per app, `rate_limited`) and `FORMS_PER_APP_PER_DAY` (200,
    `limit_exceeded`); then the row and the notification. A failed
    notification (the app's mail limit, the global pause) never loses the
    submission: it stays stored with `notified_at` null, the answer says
    `notified: false`, and a `forms_notify_failed` log line (error code only);
  - `GET :form/submissions?limit=1..100&before=<cursor>` (rule `admin`) →
    `{ submissions: [{ id, created_at, data, user_id, notified }],
    next_cursor }`, newest first;
  - `GET :form/submissions.csv` (rule `admin`) → `text/csv` attachment (≤ 10 000
    rows; columns `id, created_at` + every field name, sorted), cells through
    `@drobek/core`'s CSV writer `csvLine` (formula prefixes `= + - @ tab CR`
    neutralized with `'`); audit `forms.export` (form + row count).
  Every answer is `Cache-Control: no-store`; logs carry ids and counts, never
  field values.
- **Config** `{ forms: { <name>: { rules: { submit }, notify: { emails,
  owners } } } }` (≤ 50 forms; an undeclared form uses the defaults: public,
  owners notified). **Any change to `notify.emails`** (≤ 10 addresses) needs
  the owner's confirmation; `notify.owners: false` stores only.
- **Notification**: `ctx.email.send({ to: [{ config:
  'forms.<name>.notify.emails' }, { appOwners: true }] })`, subject `New
  "<form>" submission — <app name>`, the fields as plain text (escaped into
  the layout: HTML in a field is never rendered), a link to the app in the
  dashboard.
- **Table** `mod_forms_submissions (id, app_id, form, data jsonb, ip_hash,
  user_id, notified_at, created_at)`, cascade on app delete, index `(app_id,
  form, created_at DESC, id DESC)`. `ip_hash` is a keyed HMAC of the client
  IP (per app), never the IP.
- **SDK**: `drobek.forms.prepare(form)`, `submit(form, data | FormData)` (waits
  for the token, retries once on a stale token), `submissions(form, opts)`,
  `csvUrl(form)`; the inline source `drobek/forms`: `<Form name success
  onSuccess onError>` — a `<form>` with the hidden honeypot, the token fetched
  on mount, a `role="status"` success and a `role="alert"` error.

## The built-in `data` module

[`modules/data`](../modules/data) (`drobek-module-data`): per-app collections
of JSON records with per-operation rules. `skill_info('data')`.

- **Config** `{ collections: { <name>: { schema?, rules?: { read, create,
  update, delete } } } }` (≤ 100 collections; names
  `^[A-Za-z][A-Za-z0-9_-]{0,63}$`). Only declared collections exist —
  anything else is `404 not_found`, except a collection declared only in
  the app's pending change: `409 pending_confirmation` (`details.collection`)
  until the owner confirms it; nothing is read or stored before. A rule is `public | user | owner | admin
  | none` joined with `|`; a rule left out takes the default
  `{ read: 'owner|admin', create: 'user', update: 'owner|admin', delete:
  'owner|admin' }` (each user sees and changes their own records, the app's
  admins all). `schema` (optional JSON Schema, compiled with ajv at
  configure time): every write is validated (`422 validation_failed` with
  field `details`), and only its properties can be filtered and sorted on.
- **Needs the owner's confirmation** (`confirmRequired`, uses the context's
  db): any operation opened to `public` (except `read` of a NEW collection
  that holds no records), `read` / `update` / `delete` opened to every
  signed-in user (`user`; `read` again except for a NEW empty collection),
  removing the `schema` of a collection that holds records, removing a
  collection that holds records (the pending summary names the count). On
  confirmation (`onConfirmed`) the removed collections' records are purged in
  the confirm transaction (audit `data.collection.purge`, collection + count);
  an empty collection is removed at once. Nothing is left behind to count
  towards the quota invisibly (stragglers show up as orphans, above).
- **Routes** (`/__drobek/v1/data/…`, every app host; the preview and
  production hosts share the app's records):
  - `GET :collection?filter=<json>&sort=&dir=&limit=&cursor=` (rule `read`)
    → `{ records, next_cursor }`, newest first by default, `limit` 1–200
    (default 50), keyset cursor. Under a read rule with `owner` a signed-in
    user who is not otherwise admitted lists exactly their own records;
  - `POST :collection` (rule `create`) → `201` the record;
  - `GET :collection/:id` (`read`), `PATCH :collection/:id` (`update`,
    shallow merge), `DELETE :collection/:id` (`delete`) → the record /
    `{ id, deleted: true }`;
  - `GET :collection/export.csv?filter=&sort=&dir=` (rule `admin`) →
    `text/csv` attachment through `@drobek/core` `csvLine` (formulas
    neutralized), audit `data.export`.
  A record is `{ _id, _owner, _created_at, _updated_at, …fields }`. The `_…`
  fields are the server's: sent by a client they are dropped. `_owner` is the
  principal's id at create time (null for a visitor) and never changes;
  `owner` rules compare it with the caller's end-user id. A visitor who is
  not signed in gets every record WITHOUT `_owner` (list, get, create,
  update): the opaque id would link one user's records for anyone reading a
  `public` collection; signed-in users, `query_data` and the Data tab keep
  it (the SDK type has `_owner?`). For get / update /
  delete a visitor gets `401` before the lookup when the rule can never admit
  them; then `404` for a missing record; then the rule against the stored
  owner (`403`).
- **Filters** (injection-safe, `query-build.ts`): `{ field: value }` or
  `{ field: { eq|ne|gt|gte|lt|lte|in|contains: value } }`, scalar values
  (strings ≤ 500 characters, `in` ≤ 50 values), ≤ 8 conditions; with a
  schema only its properties, without one identifier-shaped names, never
  `_…`. Field names and values are always bound SQL parameters.
- **Limits** (on every write, whatever the rules): `DATA_MAX_DOC_BYTES`
  (100 KiB, `413 payload_too_large`), `DATA_MAX_DOCS_PER_APP` (10 000) and
  `DATA_MAX_BYTES_PER_APP` (50 MiB) → `409 quota_exceeded` (exact under a
  per-app advisory lock). Rate limits (`429 rate_limited` + `Retry-After`,
  `details.limit` names the one that tripped): first the caller's own
  bucket, `DATA_WRITES_PER_PRINCIPAL_PER_MIN` (60 per minute per signed-in
  user, or per client IP for a visitor; a visitor without a resolvable IP has
  none), then `DATA_WRITE_RATE_LIMIT` per `DATA_WRITE_RATE_WINDOW_MS` (120 /
  60 s per app) — so one anonymous client on `create: public` cannot use up
  the app's budget for everyone (a refused write counts only against its own
  bucket).
- **Records authority** → MCP `query_data` (scope `read`, ≤ 100 records,
  text only inside a nonce envelope) and the dashboard Data tab.
- **Table** `mod_data_documents (id, app_id, collection, owner_id, doc jsonb,
  bytes, created_at, updated_at)`, cascade on app delete. Its first migration
  imports the pre-module Data API (core tables `collections` +
  `app_documents`): every collection becomes a declared collection (schema
  kept; `access_mode` → rules: `public-read` → `{read: public, create /
  update / delete: admin}`, `public-write` → `{read: public, create: public,
  update / delete: admin}`, `locked` → all `admin`, `owner-only` →
  `{read: owner|admin, create: user, update / delete: owner|admin}`), every
  live document a record; then the old tables and enum are dropped. Every
  statement is re-runnable.
- **SDK** `drobek.data.collection<T>(name)` → `list(opts)`, `get(id)`,
  `create(fields)`, `update(id, fields)`, `remove(id)`, `exportCsvUrl(opts)`;
  the types (`Doc<T>`, `Filter<T>`, `Page<T>`) are in `/__drobek/sdk.d.ts`.

## The built-in `proxy` module

[`modules/proxy`](../modules/proxy) (`drobek-module-proxy`, NSO-297): an app
calls an external API without holding its secret. `skill_info('proxy')`.

- **Upstreams are workspace-level** (`@drobek/proxy`, dashboard → workspace →
  Upstreams, workspace-admin only): `name`, `base_url` (http(s), a public host,
  **port 80/443 only** — `PROXY_ALLOWED_PORTS`, PHY-76 #8; anything else is
  `invalid_request` at registration and `ssrf_blocked` at connect time),
  allowed methods + path prefixes, `auth_type` `none | bearer | header` and
  the write-only secret (AES-256-GCM envelope under `DROBEK_MASTER_KEY`).
  Over MCP (NSO-372, workspace-admin): `list_upstreams`, `register_upstream`
  (the same checks; `auth_type: none` registers at once, `bearer` / `header`
  answer `registered: false` + `secret_url`, the Upstreams form filled in via
  query parameters — the secret is never an MCP argument) and
  `remove_upstream` (`user_confirmed: true`). Audit rows name the agent.
  Assigning (or re-binding) a name no upstream is registered under is refused
  at `configure_module` (`invalid_params`, `details.reason:
  upstream_not_registered`).
- **Config** `{ upstreams: { <name>: { rules: { call }, rateLimit?, id? } } }`
  (≤ 20): assigns a workspace upstream to the app. `call` = `user` (default) |
  `admin` | `public` | `none` (alternatives with `|`; `owner` is refused).
  **Assigning an upstream** and **opening `call` to `public`** need the
  confirmation of a **workspace admin** (`confirmRole: 'admin'` — an editor
  cannot let an app spend a secret an admin registered). Confirming an
  assignment puts the app on the upstream's allow-list (`allowed_app_ids`)
  and binds it to that upstream RECORD: drobek writes the record's `id` into
  the assignment (NSO-326; the agent never writes it — a written `id` that
  differs from the bound one is a rebind and needs an admin too). A deleted
  and re-registered upstream is a new record, so its old assignments stop
  working until they are removed, added again and confirmed. A config from
  before the binding (name only) is bound lazily by its first call, when the
  app is on the current record's allow-list; no migration.
- **Route** `GET|HEAD|POST|PUT|PATCH|DELETE /__drobek/v1/proxy/:upstream/*`
  (raw body ≤ 1 MiB). In order: `X-Drobek-SDK: 1` on every method (`403
  csrf_rejected` — a call spends the owner's key, so not even a cross-site GET);
  assigned to the app (`403 forbidden`, `details.reason:
  upstream_not_assigned`); the `call` rule (`401` / `403`); rate limits —
  `PROXY_PUBLIC_CALLS_PER_MIN_PER_IP` (10, `public` upstreams only),
  `PROXY_CALLS_PER_MIN` (60 per app, all upstreams) and the assignment's
  `rateLimit` (`429 rate_limited` + `Retry-After`); a slot among the calls in
  flight — `PROXY_MAX_CONCURRENT` (32, the whole server) and
  `PROXY_MAX_CONCURRENT_PER_APP` (8), each call holds up to 5 MiB for up to
  20 s (`429 proxy_busy` + `Retry-After: 1`, nothing queues); registered in
  the app's workspace (`404 not_found`, `upstream_not_registered`); the
  record the assignment is bound to (`403 forbidden`, `upstream_replaced`);
  the app on the upstream's allow-list (`403 forbidden`,
  `upstream_not_allowed` — empty = no app; an assignment whose upstream was
  deleted after it was proposed is removed and added again); then
  `@drobek/proxy` `forwardToUpstream`: the method/path allow-lists (`405
  method_not_allowed` / `403 path_not_allowed`, traversal-proof: each segment
  is checked fully percent-decoded, up to 3 rounds, and a multiply encoded one
  is forwarded re-encoded from its decoded value), the secret
  decrypted in memory and injected (`Authorization: Bearer …` or the named
  header), the client's `Cookie`, `Authorization`, hop-by-hop, `X-Forwarded-*`,
  `Forwarded`, `Via`, `Origin`, `Referer`, `Sec-*` and `X-Drobek-SDK` stripped,
  `Accept-Encoding: identity`, `User-Agent: drobek
  (+https://github.com/freema/drobek)` when the caller sent none (a sync run,
  a module job), a request body sent with `Content-Length`
  (never chunked); the SSRF guard (DNS resolved once + pinned IP,
  private/reserved ranges blocked unless on `PROXY_ALLOWED_HOSTS` — IPv6
  includes 6to4 `2002::/16`, local-use NAT64 `64:ff9b:1::/48`, site-local
  `fec0::/10` and discard `100::/64` — ports 80/443, 20 s deadline, 5 MiB
  response cap, both for the whole redirect chain; a HEAD answer's
  `Content-Length` is not held to the cap → `ssrf_blocked` 403 (audited as
  `proxy.blocked`) / `upstream_error` 502). A 301/302/303/307/308 is
  followed — at most 3 hops, each through the SSRF guard again with the
  secret injected — only when its target keeps the base URL's scheme, host
  and port, stays under the base path and the allowed path prefixes and the
  resulting method is allowed (301/302/303 turn a non-GET/HEAD request into a
  GET without a body, 307/308 resend method and body). Any other redirect —
  another origin, a path outside the prefixes, a fourth hop, a loop — and any
  other 3xx but 304 is `upstream_redirect` 502 with `details.location_path`
  (the target's path, never its host); no 3xx but 304 reaches the app.
  A `Content-Encoding` the upstream sends anyway (`gzip`, `deflate`, `br`) is decoded and the DECODED body must
  fit the 5 MiB cap (else `upstream_error`). The response keeps the
  upstream's status; its headers pass through an **allow-list**
  (`Content-Type`, `Content-Language`, `Content-Range`, `Accept-Ranges`,
  `ETag`, `Last-Modified`, `Expires`, `Pragma`, `Vary`, `Date`, `Age`,
  `Retry-After`, request ids like `X-Request-Id`, rate-limit hints
  `X-RateLimit-*` / `RateLimit-*`, `Content-Disposition` unless the answer is
  HTML, `Location` only when relative) — so `Set-Cookie`, `Access-Control-*`,
  `Clear-Site-Data`, `Refresh`, `Link`, HSTS, `Service-Worker-Allowed` and an
  absolute `Location` never reach the app origin — with
  `Cache-Control: no-store`.
- **Info**: `get_app` → `modules.proxy.info.upstreams: [{ name, registered,
  assigned, call?, rateLimit?, hasSecret, allowedMethods?, allowedPathPrefixes?
  }]` (never the secret or the base URL).
- **SDK**: `drobek.proxy.fetch(upstream, path?, init?)` → the standard
  `Response` (same-origin fetch with `X-Drobek-SDK: 1`).
- The old dashboard-host route `/:ws/api/proxy/:name/*` (workspace members
  with a dashboard session) is gone.
## The built-in `files` module

[`modules/files`](../modules/files) (`drobek-module-files`): files the
people who use an app upload. `skill_info('files')`.

- **Routes** (`/__drobek/v1/files/…`):
  - `POST /` (`bodyTypes: ['file']`, rule `rules.upload`; `owner` admits the
    uploader like data's create) → `201 { id, url, size, type, name, owner,
    created_at }`. In order: the rule; `FILES_UPLOADS_PER_PRINCIPAL_PER_MIN`
    (20 per minute per signed-in uploader, or per client IP for a visitor;
    none without a resolvable IP), then `FILES_UPLOAD_RATE_LIMIT` (60 uploads
    per minute per app) — `429 rate_limited`; a declared `Content-Length` over
    the per-file cap (+ 65 KiB of framing) → `413` before anything is read;
    the app already at its quota → `409 quota_exceeded` before anything is
    read; then the file streams to `FILES_DIR/tmp/<uuid>.part` while it is
    counted (past the cap: `413 payload_too_large`, the rest discarded),
    sha256-hashed and sniffed (`415 unsupported_type` as soon as the bytes can
    be no accepted type, or at the end); an empty file is `400`; the quota
    again, exactly, under a per-app advisory lock; then the row and the
    rename to `FILES_DIR/<sha[0:2]>/<sha[2:4]>/<sha256>` (the same content
    of any app is stored once). Every failure removes the temp file. Audit
    `files.upload` (id, size, type);
  - `GET /:id` (rule `rules.read`; a visitor the rule can never admit gets
    `401` before any lookup; `owner` = the uploader) → the bytes, streamed:
    the SNIFFED `Content-Type` (`text/csv; charset=utf-8`),
    `X-Content-Type-Options: nosniff`, `Content-Disposition: inline` for
    PNG/JPEG/GIF/WebP/PDF and `attachment` for SVG and CSV (with an ASCII
    `filename` and a UTF-8 `filename*`), `ETag: "<sha256>"` (304 on
    `If-None-Match`), `Content-Security-Policy: sandbox` on every type but
    PDF (browsers' PDF viewers refuse to render in a sandbox; the apps host
    sends it as a second policy after the app CSP — a module CSP can only
    tighten the app's), `Cache-Control: public, max-age=300,
    must-revalidate` when the read rule is `public` (the URL names the file
    id, not its content, so a delete or a stricter rule must reach shared
    caches — within 5 minutes, then an ETag revalidation), else `private,
    no-cache`. The blob is opened before any header: a file deleted during
    the download still streams in full, one already gone is a clean `404`;
  - `DELETE /:id` (fixed rule `owner|admin`) → `{ id, deleted: true }`; the
    blob is unlinked only when no `mod_files` row of ANY app references its
    sha256 any more (under a per-sha256 advisory lock shared with uploads).
    Audit `files.delete`;
  - `GET /?limit=1..200&cursor=` (rule `admin`) → `{ files, next_cursor,
    used_bytes, quota_bytes }`, newest first.
- **Types** (sniffed from the bytes, never the name or the declared type):
  PNG, JPEG, GIF, WebP and PDF by their magic bytes; SVG = valid UTF-8 text
  whose root element is `<svg` (after an optional BOM, XML declaration,
  comments, DOCTYPE); CSV = valid UTF-8 text without control characters or
  markup that the client ALSO calls CSV (`text/csv`-ish type or `.csv`
  name). Anything else — an HTML page named `.png` — is `415
  unsupported_type`.
- **Config** `{ rules: { upload, read }, maxBytes?, allowedTypes }`
  (defaults `user` / `user`, no `maxBytes`, `['image/*',
  'application/pdf', 'text/csv']`). `maxBytes` only lowers
  `FILES_MAX_BYTES`. Opening `upload` to `public`, or `read` to `public`
  while the app holds files, needs the owner's confirmation.
- **Limits**: `FILES_MAX_BYTES` 10 MiB, `FILES_QUOTA_PER_APP` 500 MiB (the
  sum of the app's `mod_files.size`, per row even when content is shared),
  `FILES_UPLOADS_PER_PRINCIPAL_PER_MIN` 20/min per user or visitor IP,
  `FILES_UPLOAD_RATE_LIMIT` 60/min per app. The directory is `FILES_DIR` (default
  `/data/files`; the production compose mounts the `files_data` volume).
- **Table** `mod_files (id, app_id, sha256, size, type, name, owner_id,
  created_at)`, cascade on app delete, indexes `(app_id, created_at DESC,
  id DESC)` and `(sha256)`.
- **Sweep** (`startFilesSweep`, run by the server's background jobs when
  `files` is active; every `FILES_SWEEP_INTERVAL_MS` = 1 h, one replica per
  interval via a Redis lease): removes the rows of apps deleted at least
  `FILES_SWEEP_RETENTION_MS` (24 h) ago (an app delete is a soft delete;
  the app purge removes any row left `APP_PURGE_AFTER_DAYS` after it),
  temp uploads `FILES_DIR/tmp/*.part` untouched for that long, and blobs
  older than that which no `mod_files` row of ANY app references — each
  under its per-sha256 advisory lock with a fresh reference count, the
  delete path's dedupe rule.
- **Request bodies** (all module routes, `packages/serving`): an answer sent
  before the body fully arrived (a `413` mid-upload, a `401` before the
  route read anything) goes out with `Connection: close`; the connection
  lingers 2 s after the answer, then closes — the rest of the upload is not
  drained. A body that does not arrive within `APPS_MODULE_BODY_TIMEOUT_MS`
  (2 min) gets `408 request_timeout`.
- **SDK**: `drobek.files.upload(file, { name?, signal? })` (a `FormData`
  through the SDK core), `url(id)`, `remove(id)`, `list({ limit?, cursor? })`.
- **Not in v1**: image transformations, EXIF stripping, object storage (S3),
  public galleries.

## The built-in `sync` module

[`modules/sync`](../modules/sync) (`drobek-module-sync`, contract `^1.2`,
requires `proxy` and `data`): an app's data collection filled from an
external API on a schedule — scores, prices, fixtures, a feed — without app
code on the server and without the API key leaving the dashboard.
`skill_info('sync')`. The dashboard calls it **Scheduled imports (sync)**
("works like a cron job"); the identifier stays `sync`.

- **Config** — `sources: { <name>: { upstream, path, method, body?, every,
  collection, items, key?, mode, paused? } }`: `upstream` is assigned to the
  app in the proxy config, `path` (default `/`, with a query) is below its
  base URL, `method` `GET` (default) or `POST` with `body`, `every` `'5m'` …
  `'30d'` (default `'1h'`), `collection` is declared in the data config,
  `items` the dotted path of the array in the answer (`''` = the answer),
  `mode` `replace` (default) or `upsert` by `key`. A new source, or a changed
  upstream, path, method, body, collection or mode, waits for the owner's
  confirmation; `every`, `items`, `key` and `paused` apply at once.
  `configure_module` refuses a source past `SYNC_MAX_SOURCES_PER_APP` and an
  `every` below `SYNC_MIN_INTERVAL_MIN` (only where the change sets it).
  In the dashboard form the upstream, the collection, the schedule (`5m` …
  `24h` from `SYNC_MIN_INTERVAL_MIN`, a custom `every` kept) and the mode
  are selects; `items` and `key` are optional fields with a hint each.
- **Runs** — the module's app job (every minute while the app has a source)
  runs each due source: it takes the source's lease in `mod_sync_sources`
  (one run of a source at a time, across replicas), counts it against
  `SYNC_RUNS_PER_HOUR_PER_APP`, fetches through `ctx.upstreams.fetch`
  (`SYNC_MAX_RESPONSE_BYTES`), takes the array at `items`
  (`SYNC_MAX_RECORDS_PER_RUN`) and writes it with `ctx.records.import`. A
  failed run (a non-2xx answer, no JSON, no array, a record the schema
  refuses, a quota) changes nothing. Every run is stored (the newest 50 per
  source in `mod_sync_runs`, what `get_logs({ kind: 'sync' })` reads). A run
  by hand and a failed scheduled run are also audited `sync.run`
  (`{ source, trigger, status, records, error?, paused? }` — `paused: true`
  on the run that paused the source; no user for a scheduled run); a
  successful scheduled run is not. Its error text names the problem, never the upstream's data or the
  secret.
- **Failures** — a failed run backs the next scheduled one off (the
  interval, doubling, at most a day or the interval); after
  `SYNC_PAUSE_AFTER_FAILURES` failures in a row the source pauses: the app
  page, its Modules tab and the module page show a banner. A successful Run
  now, the owner's Resume (audited `sync.resume`) or a change of the source's
  config starts it again.
- **The owner** — the module page lists the sources (what they fetch and
  write, the schedule, the last and the next run) with Run now and Pause /
  Resume (Pause sets the source's `paused` without a confirmation), and the
  latest runs. Over MCP: `sync_now({ app_id, source })` (editor+,
  `SYNC_NOW_PER_MINUTE` per source) and `get_logs({ app_id, kind: 'sync' })`;
  `get_app` shows each source's state under `modules.sync.info.sources`.
- `duplicate_app` never copies the sources (they would start calling an
  external API from the copy); deleting the app removes its sources and runs.

## The built-in `oidc` module

[`modules/oidc`](../modules/oidc) (`drobek-module-oidc`, contract `^1.1`,
requires `auth`): company sign-in with any OpenID Connect provider —
Google, Microsoft Entra ID, Okta, Keycloak, Auth0 — as the `auth.provider`
`oidc`, without per-IdP code. `skill_info('oidc')`. The module has no
config, routes, SDK or tables of its own; auth keeps state, nonce, PKCE,
the allowlist, users and sessions ([Auth providers](#auth-providers)).

- **Config** — in the AUTH config, `providers.oidc: { enabled, issuer?,
  clientId?, scopes (["openid","email","profile"], must include openid),
  trustEmail (false), label ("Company account"), claims?: { email? },
  prompt? (select_account | login | consent), relinkByEmail? }`.
  `identityFields: ['issuer', 'clientId', 'trustEmail', 'claims']` —
  enabling it and changing any of them wait for the owner (`trustEmail` and
  `claims` decide which address a person may claim). The issuer is https (http only outside production),
  without query or fragment.
- **Secrets and the env fallback** — `OIDC_CLIENT_SECRET` (the auth module's
  per-app secret, env fallback `AUTH_OIDC_CLIENT_SECRET`). An app without
  an `issuer` uses the operator's `AUTH_OIDC_ISSUER` with
  `AUTH_OIDC_CLIENT_ID` (or its own `clientId`); the server's client never
  pairs with an app's own issuer. The redirect URI to register at the IdP is
  `<PUBLIC_APP_URL>/__drobek/auth/callback/oidc`.
- **begin** — discovery at `<issuer>/.well-known/openid-configuration`: its
  `issuer` must equal the configured one exactly (a Microsoft `/common`
  issuer never does: use the tenant's), the endpoints must be https, and a
  document that lists `code_challenge_methods_supported` without `S256` is
  refused (one that lists none — Entra ID — gets S256 all the same). The
  answer is the `authorization_endpoint` with `response_type=code`,
  `client_id`, `redirect_uri`, `scope`, `state`, `nonce`,
  `code_challenge`, `code_challenge_method=S256` and `prompt`. Without a
  client secret it fails at once unless the IdP lists
  `token_endpoint_auth_methods_supported: none`.
- **callback** — an IdP `error` or an `iss` parameter naming another issuer
  (RFC 9207) fails; the code is exchanged at `token_endpoint` with the PKCE
  verifier and `client_secret_basic` (else `client_secret_post`, as the
  document lists; `client_secret_basic` when it lists nothing). The ID
  token: `alg` RS256, ES256 or PS256 and advertised in
  `id_token_signing_alg_values_supported` (RS256 when absent; `none` and
  HS* never), no `crit`, a signature by a key of `jwks_uri` (`kid`, `kty`,
  `use`, `alg` matching; RSA ≥ 2048 bits, EC P-256; `node:crypto`, no JOSE
  library), `iss` = the issuer, `aud` names the client (with several
  audiences, or any `azp`, `azp` = the client), `exp` in the future, `iat`
  within 5 minutes, `nonce` = the sign-in's. The address is the `email`
  claim (or `claims.email`) of the ID token, else of `userinfo` (Bearer
  access token; its `sub` must match); `email_verified` (`true` or
  `"true"`) from the same source, or `trustEmail`. The identity is `{
  issuer: iss, subject: sub, email (lower case), emailVerified, name? }`.
- **Network** — every IdP call goes through the `@drobek/proxy` SSRF guard
  (resolved once and pinned, private and reserved addresses refused, no
  redirects), 5 s, at most 64 KiB, ports 443 / `PROXY_ALLOWED_PORTS`;
  `PROXY_ALLOWED_HOSTS` never applies. Only the host of the operator's
  `AUTH_OIDC_ISSUER` may be private and on any port, and — outside
  production — the exact origins in `AUTH_OIDC_DEV_ORIGINS` also over http.
- **Caches** — in process memory (a provider gets no Redis): the discovery
  document per issuer `OIDC_DISCOVERY_CACHE_SEC` (3600, read from the
  server's env: the provider gets no workspace limits), the keys per issuer
  1 hour; a token with an unknown `kid` refetches them at most once a
  minute.
- **Failures** — an `OidcError` named `oidc_discovery_failed` or
  `oidc_token_invalid`: auth logs the name and answers `provider_error`;
  the module logs `oidc: sign-in begin|callback failed { app_id, error,
  reason }` with addresses masked. No log line or error carries the client
  secret, a code or a token.
- **Testing** — `tests-e2e/mock-oidc.mjs` (`task mock:oidc`, port 3050) is a
  dependency-free IdP: discovery, `/jwks`, an RS256 ID token from a key made
  at start, the nonce and the PKCE verifier checked. The dev stack reaches it
  over http through `AUTH_OIDC_DEV_ORIGINS`; the e2e image flow runs it behind
  its Caddy over https as the server's `AUTH_OIDC_ISSUER`.

## The example: `drobek-module-hello`

[`examples/drobek-module-hello`](../examples/drobek-module-hello) is an
external workspace package, loaded exactly as a third-party module would be
(`DROBEK_MODULES=hello` → `drobek-module-hello`, a dependency of
`apps/server`). It is what `npm create drobek-module@latest hello` generates
(the files, scripts and tests; a unit test regenerates the scaffold and
compares) plus the slot demo:

- `GET /__drobek/v1/hello` → `{ greeting, message, waves, signed, signature? }`;
- `POST /__drobek/v1/hello/wave` `{ name }` → `{ waves }`, rate-limited per
  visitor IP (`HELLO_WAVES_PER_MINUTE`, default 30);
- config `{ greeting, excited }`; a greeting change needs the owner's
  confirmation, `excited` applies at once;
- optional secret `HELLO_SIGNATURE` (the ping is HMAC-signed when set);
- table `mod_hello_waves` (its own migrations and journal);
- `GET /__drobek/v1/hello/whoami` → the visitor as `ctx.principal` (signed in
  through the auth module with the current role, or `{ signed_in: false }`);
- `GET /__drobek/v1/hello/greet?name=Ada&greeter=<id>` → `{ text, greeter }`:
  the configured greeting, or a greeter another module contributes to the
  slot `hello.greeter` (`{ id, greet(name) }`, unique by `id`); an unknown id
  answers the module's own error `unknown_greeter` (404, `details.available`);
- `drobek.hello.ping()` / `wave(name)` / `whoami()` / `greet(name, greeter?)`
  in the browser;
- its `SKILL.md` is what `skill_info('hello')` returns.

Try it in the dev stack: create an app with an agent, write

```ts
import { drobek } from 'drobek';
drobek.hello.ping().then((h) => (document.body.textContent = h.message));
```

and open the `preview_url`.

## The example: `drobek-module-acme-crm`

[`examples/drobek-module-acme-crm`](../examples/drobek-module-acme-crm) is the
scaffold's output for `acme-crm` turned into an opt-in module `acmecrm`
(contract `^1.2`, requires `auth`). It is never a dependency of
`apps/server`: `task dev` packs it and installs it into `./.modules` with
`task module:add`, the e2e image flow installs it with
`selfhost:module:add`, and `DROBEK_MODULES` names it by its package,
`drobek-module-acme-crm`, so `/healthz` lists it with `source: dir`.

- `GET /__drobek/v1/acmecrm` → `{ contacts, upstream }`, `POST` `{ email, name?, fields? }`
  → the new contact; both need a signed-in end user (rule `user`);
- an `auth.signedIn` contribution adds every end user who signs in
  (`source: "sign-in"`);
- config `{ tags, fields }` (a list and a record, so the dashboard's generic
  form shows both kinds of field);
- the own error `crm_duplicate` (409, `details.email`), the limit
  `ACMECRM_CONTACTS_PER_APP` (default 1000), the optional secret
  `ACMECRM_API_KEY` (`upstream: true` once the owner set it);
- table `mod_acmecrm_contacts` under the journal
  `__drizzle_migrations_mod_acmecrm`;
- off for every workspace until a super-admin enables it, or the limits
  provider's plan says `MODULE_ENABLED_ACMECRM=1`.
