# drobek skill

Teaches an agent (Claude Code, Codex, Cursor) to build and change apps in a drobek workspace;
it is intentionally thin: it teaches the WORKFLOW and
links the authoritative, always-current schemas (llms-full.txt + the MCP docs
resources) instead of duplicating them.

## Install (one command)

From a checkout of this repo:

```sh
cp -r skills/drobek ~/.claude/skills/drobek
```

That installs it as a user-level Claude Code skill. For a project-local install,
copy it to `.claude/skills/drobek` inside your project instead. Cursor and other
agents can read `SKILL.md` directly.

## Or: the drobek plugin

For the hosted drobek (`https://drobek.app/mcp`), the
[drobek plugin](https://github.com/freema/drobek-plugin) bundles the MCP server,
a `build-app-on-drobek` skill (Claude Code, Codex and Cursor variants that follow
this skill's loop and rules), the `/drobek:build-app` command and
`/drobek:port-artifact` (move a Claude artifact to drobek). Claude Code:

```sh
claude plugin marketplace add freema/drobek-plugin
claude plugin install drobek@drobek
```

Codex and Cursor install steps are in the plugin repository.

## Connect the MCP server

Point your agent's MCP client at the drobek MCP endpoint (default
`http://localhost:3041/mcp`, i.e. your deployment's `PUBLIC_APP_URL` + `/mcp`).
It is OAuth 2.1 (PKCE S256) — your MCP client drives discovery → registration →
consent → token automatically. See the "Connect" section of llms-full.txt.

## Maintenance rule (enforced)

**Any unit that changes the MCP tool surface or the SDK updates the drobek skill
(this folder) AND llms.txt / llms-full.txt in the SAME PR.**

- The tool-name half of that rule is enforced by a test, not by discipline: the
  drift-guard unit test in `@drobek/oauth`
  (`packages/oauth/src/resource/tool-docs-parity.test.ts`) asserts the set of
  tools the MCP server actually registers EQUALS `TOOL_NAMES` in
  `@drobek/agent-dx` — names, input fields, annotations and scopes. Add a tool
  without a doc (or remove a doc for a live tool) and CI fails.
- The docs (llms.txt / llms-full.txt / the MCP docs resources / the build page)
  render from the same `@drobek/agent-dx` manifest, so updating the manifest
  updates every surface at once. This SKILL.md is hand-written; the unit test
  `packages/agent-dx/src/skill.test.ts` asserts it names every tool, carries the
  loop rules and states `SKILL_INFO_RULE` verbatim.
- `skill_info` lists the server's skills; this platform skill is NOT among
  them (it is what connects an agent to drobek in the first place — an agent
  calling `skill_info` already has it and the briefing). General skills for
  `skill_info` live next to it as `skills/<name>/SKILL.md` (frontmatter
  `name` + `description` = the "use when…" sentence).
- The plugin's skills (freema/drobek-plugin) carry the same loop and rules; its
  `scripts/check-drobek.mjs` holds the same tool list and skills rule — update
  it together with `TOOL_DOCS`.

The same rule is one of the hard rules in the repository's `CLAUDE.md`.
