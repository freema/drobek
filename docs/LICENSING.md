# Licensing

drobek is licensed under the **GNU Affero General Public License v3.0**
([`LICENSE`](../LICENSE)) — the whole repository: the server, the dashboard,
the MCP server, the platform modules in `modules/`, the browser SDK, the
Caddyfile generator, the compose files and scripts, the skills. There is one
licence and no other: no commercial or proprietary edition of this code, no
licence exception, no contributor licence agreement.

This page explains what that means in practice. It is not legal advice.

## What the AGPL asks of you

The AGPL is the GPL plus one clause, **§13 "Remote Network Interaction"**: if
you run a **modified** version of drobek and let people interact with it over
a network, you must offer those users the corresponding source of the version
you run, under the same licence.

- **Running drobek unmodified** (the published image, any release) for
  yourself, your company or your customers: nothing to do beyond keeping the
  licence notices. The source is already public.
- **Running a modified drobek** that other people use — a patch, an added
  module in the image, a changed dashboard: offer its complete source to those
  users (a link from the running instance to a public repository or archive
  of exactly that version is the usual way).
- **Distributing** drobek (an image, a package, a copy of the repository):
  the GPL rules — include the licence and the source (or a written offer).
- **Using drobek does not put your apps under the AGPL.** The files an agent
  writes into an app are the app author's; drobek compiles and serves them
  but does not combine them with its own code. The browser SDK
  (`/__drobek/sdk.js`) and the inline module components (`drobek/<module>`)
  that an app imports are drobek's code under the AGPL-3.0, delivered next to
  the app's own files.

### How drobek helps you comply

- Every dashboard page has a footer **`Source (AGPL-3.0) · <commit>`** linking
  to the source repository at the commit the image was built from
  (`GIT_SHA`, `@drobek/dashboard` `source-link.ts`).
- `GET /api/version` answers `{ sha, version }` — the commit and the release
  tag of the running image.
- Release images are built by CI from a git tag and tagged `vX.Y.Z`
  (`docs/SELF-HOSTING.md` → Image tags), so "the source of the version I run"
  is always a tag in the public repository.

If you modify drobek, point the footer link at **your** repository (the
constant `SOURCE_REPO_URL` in `packages/dashboard/src/source-link.ts`) and
build with your own commit.

### Modules

A platform module is an npm package the operator adds to the server
(`DROBEK_MODULES`); it runs inside the drobek process through the
`@drobek/modules` contract. The built-in modules are part of this repository
and AGPL-3.0. When you run drobek with a module of your own added and offer it
to users over the network, treat the module as part of the program you run
for §13 — its source belongs to what you offer.

## The boundary with drobek-web (the hosted drobek.app)

drobek.app is operated from a separate, private repository, **drobek-web**.
It is a thin operations layer at arm's length from this code:

| drobek-web holds | drobek-web does NOT hold |
| --- | --- |
| deployment: compose files, reverse-proxy / TLS configuration, the deploy workflow pinned to a published `ghcr.io/freema/drobek` image tag, runbooks | a fork, a patched copy or a wrapper of drobek |
| a **limits provider**: a separate process that answers drobek's `GET /limits/<workspace_id>` (HMAC-signed HTTP, `LIMITS_PROVIDER_URL`) from plans and billing accounts in its own database | code linked into, imported by or loaded into the drobek process |
| the marketing site | any drobek feature a self-hoster would need |

So:

- drobek.app runs the **same unmodified public image** that any self-hoster
  can pull. §13 is satisfied by the public repository itself; the footer
  links to it.
- drobek and the limits provider are **two programs talking over a documented
  HTTP protocol** (`docs/MODULES.md` → Limits and the limits provider), not
  one combined work. Anyone can implement the same endpoint for their own
  plans.
- The rule for what goes where: **anything a self-hoster needs to use the
  product completely is in drobek, under the AGPL** — the dashboard,
  modules, custom domains, TLS, abuse handling, backups, the agent tooling.
  Plans, billing, signup gating and the marketing site are not needed to use
  drobek and stay in the SaaS.

## Related repositories

- [`freema/drobek-plugin`](https://github.com/freema/drobek-plugin) — the agent
  plugin (MCP connection + build skill for Claude Code, Codex and Cursor) — is
  a separate project under its own licence (MIT); it talks to drobek only over
  MCP.
