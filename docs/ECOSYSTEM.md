# Repositories and compatibility

drobek has three public repositories with separate release lifecycles.
The hosted service has a separate private deployment repository. Building,
testing or self-hosting the public platform needs no access to that repository.

| Repository | Responsibility | Integration boundary |
| --- | --- | --- |
| [drobek](https://github.com/freema/drobek) | Server, dashboard, MCP, built-in modules and public module-author packages | Versioned image, MCP protocol, npm `@freema/drobek-modules` + `@freema/drobek-sdk` (imported as `@drobek/modules` / `@drobek/sdk` via npm aliases), `create-drobek-module` |
| [drobek-plugin](https://github.com/freema/drobek-plugin) | Agent installation, commands and skills | MCP endpoint and documented tools; no server implementation imports |
| [drobek-module-counter](https://github.com/freema/drobek-module-counter) | Optional server-side counters | Public module contract, own migrations and SDK contribution |
| Private hosted-service repository | Website, deployment configuration and service-specific integrations | Released core image and documented extension interfaces |

An **agent plugin** teaches an agent how to use drobek. A **platform module**
adds backend behavior to the server. Installing an agent plugin does not
install server modules. The operator installs trusted module packages and
chooses `DROBEK_MODULES`; workspace availability and per-app configuration
then control their use. Modules run in the server process with database
access, not in a sandbox. See [module installation and trust](MODULES.md#installing-an-external-module).

The [module catalogue](MODULES.md#published-modules) links independently
released modules; a catalogue entry neither installs a module nor enables
it by default. Counter stays in its own repository so it exercises the
same public interfaces available to other module authors.

## Versions and dependency direction

Core owns the module contract and the public packages. Modules depend on
those interfaces; core does not import counter's implementation. The hosted
service consumes the core image. Its code and credentials are not prerequisites
for public builds. Agent-tool changes keep the plugin's skills synchronized
as described in [the contributor guide](../CLAUDE.md).

The core image/npm release version and `MODULE_CONTRACT_VERSION` are different
version lines. A module declares its supported contract range and peer package
ranges; its own release version is independent. See the authoritative
[compatibility table](MODULES.md#compatibility). A passing check of one pinned
counter revision establishes that pairing, not every module or every version.

App-user `auth.provider` contributions apply to users of hosted apps.
Dashboard authentication is a separate boundary; installing an app provider
does not add an administrator login method. See [end-user sessions](MODULES.md#end-user-sessions-core).

## External-consumer check

The `External module compatibility` workflow tests a pinned counter source
revision against packages built from the candidate core checkout. The
main/tag CI calls it before the image e2e and release publication, and it
can be dispatched manually (Actions → External module compatibility) for a
branch. It requires no private
repository, publishing credentials or production service.

To run it locally with a trusted counter checkout:

```sh
pnpm install --frozen-lockfile
pnpm build:packages
node scripts/check-external-module.mjs /path/to/drobek-module-counter
```

An optional second argument sets the candidate npm version, for example
`0.3.0` or `v0.3.0`. Tag CI passes the release tag, matching the npm publish
job; other runs use the package version from the checkout. This also checks
the module's peer ranges against the version that will actually ship.

The script stages and packs the candidate public packages, copies the
external module to a temporary directory, installs the tarballs, and runs
its typecheck, build and tests (including its skill examples). It then packs
the module with its original manifest and installs it in a separate consumer
to verify registry loading, packaged migration/SDK paths and SDK bundling.
The source checkout remains unchanged. Temporary files are retained for
diagnostics; npm registry access may be required. Only run trusted module
sources: their build and test scripts execute locally.

The candidate package substitutions exist only in the temporary test project.
This check neither publishes packages nor switches a deployed server's modules.
It does not replace the module's own release checks, core image E2E, or a
self-hosted upgrade rehearsal with persistent data.

To update the reference consumer, review the counter change, update the full
commit SHA in `.github/workflows/module-compatibility.yml`, run this check,
and include the core revision, counter revision and results in the PR.
Investigate failures before release: either restore the promised compatibility
or make the contract/version change and migration instructions explicit.
