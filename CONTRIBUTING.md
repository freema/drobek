# Contributing to drobek

Thanks for helping. drobek is maintained by one person, so small, focused
changes with a clear reason land fastest.

## Before you start

- **A bug** — open an issue with the bug template: the version
  (`GET /api/version`), what you did, what you expected, what happened.
- **A feature or a larger change** — start a
  [Discussion](https://github.com/freema/drobek/discussions) or an issue
  first, so we agree on the shape before you write it.
- **A security problem** — never a public issue; see [`SECURITY.md`](./SECURITY.md).
- **A new backend capability** — it can often be a module outside this
  repository instead of a change to the core:
  [`docs/MODULES.md` → Writing a module](./docs/MODULES.md#writing-a-module).
  Issues labelled [`good first issue`](https://github.com/freema/drobek/labels/good%20first%20issue)
  are a good way in.

## Picking up an issue

- **I don't assign issues on request.** "Please assign me" alone doesn't
  reserve an issue — too many claimed issues never get a pull request and
  block everyone else.
- **To work on one,** post a short plan on the issue (two or three sentences:
  where the code goes, what it adds, how you'll test it) or open a draft pull
  request that links it. I assign the issue once there is a pull request.
- **The first solid pull request wins.** If two arrive, I merge the one that
  is complete, tested and follows the rules below.
- **An assigned issue with no activity for 7 days** goes back to open, and I
  unassign it.
- One open issue per person at a time, please.

## Set up

Docker (compose v2), [go-task](https://taskfile.dev) 3, Node 22 and pnpm 10:

```sh
git clone https://github.com/freema/drobek && cd drobek
cp .env.example .env      # set SUPERADMIN_EMAIL and DROBEK_MASTER_KEY (openssl rand -hex 32)
task dev                  # drobek, postgres, redis, mailpit — http://localhost:3041
```

[`README.md` → Develop locally](./README.md#develop-locally) has the ports,
the local app hosts and the e2e setup; [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
is the map of the code.

## The rules the code follows

- Node/TypeScript only (pnpm monorepo, Node 22, ESM).
- Logic lives in `packages/*` or `modules/*`; `apps/server` only wires them.
- The server never executes app code — it compiles with esbuild and serves.
- Secrets never pass through MCP or an agent, and are never logged.
- Errors are `{ code, message, hint }` from the catalogue.
- A change to the MCP tools or the SDK updates the agent-facing docs and
  skills in the same change (`@drobek/agent-dx`, `skills/drobek`); the parity
  tests fail otherwise.
- A new operator env var goes into `.env.example`, `.env.production.example`
  and the env reference in [`docs/SELF-HOSTING.md`](./docs/SELF-HOSTING.md).
- Docs describe the current design; `pnpm doc-lint` checks it.

## Database migrations

The server applies every migration by itself when it starts, so a self-hoster
never runs one by hand. Keep it that way:

- **Core tables** (`packages/db/src/schema.ts`): change the schema, then
  `task db:generate` writes the next file into
  `packages/db/drizzle/migrations` with its journal entry and snapshot. Use the
  number it picks. Gaps in the numbering (no 0013, 0015, …) are intentional,
  numbers that were reserved for parallel work; don't fill them.
- **A module's tables** belong in the module's own `migrations/` folder with
  its own journal, never in core. Tables are named `mod_<module>_…` and every
  per-app row references `apps(id)` with `ON DELETE CASCADE`
  ([`docs/MODULES.md` → Migrations and tables](./docs/MODULES.md#migrations-and-tables)).
- **Never edit or renumber a migration that has been released.** Servers
  already ran it; fix forward with a new one.
- Write data migrations so a re-run is harmless (`IF NOT EXISTS`, guarded
  `DO $$ … $$` blocks), and test them against a database in the previous
  shape (see `modules/auth/src/migration.test.ts`).
- `packages/db/src/migration-journals.test.ts` (in `task check`) fails when a
  journal, its `.sql` files or the core snapshots disagree, e.g. after a
  merge. I re-chain conflicting migrations when I merge.

## Before you open a pull request

```sh
task check    # install, doc-lint, build, typecheck, lint, knip, unit tests — must be green
task e2e      # Playwright against the dev stack, when you changed behaviour
```

- One topic per pull request, against `main`, with tests for what changed.
- GitHub runs the `task check` pieces (without e2e) on every pull request;
  a first-time contributor's run starts once I approve it.
- A release tag also runs the release gate
  ([`docs/SELF-HOSTING.md` → Image tags](./docs/SELF-HOSTING.md#image-tags)):
  a production dependency with a high or critical advisory
  (`pnpm audit --prod --audit-level high`) blocks the release, so add or
  update dependencies to versions without one.
- Commit messages in English, in the imperative, with a scope:
  `fix(serving): …`, `feat(mcp): …`, `docs: …`.
- Say what changed for users or operators; a user-visible change also gets a
  line in [`CHANGELOG.md`](./CHANGELOG.md) under the next version.

## License

drobek is AGPL-3.0. By contributing you agree that your contribution is
licensed under the same terms ([`docs/LICENSING.md`](./docs/LICENSING.md)).
Everyone taking part follows the [Code of Conduct](./CODE_OF_CONDUCT.md).
